import { getUser, login, logout, acceptInvite } from '@netlify/identity';
import { desc, eq, sql } from 'drizzle-orm';
import { database } from '../../db/index.js';
import { bookings, type BookingItem } from '../../db/schema.js';

function reply(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
function catalog() {
  return [
    { id: 'car', name: 'Solar-Powered Car', price: 40, gaming: 0 },
    { id: 'robotics', name: 'Robotics Game', price: 35, gaming: 0 },
    { id: 'gaming', name: 'PC Gaming', price: 35, gaming: 1 },
    { id: 'quiz', name: 'Quiz Challenge', price: 100, gaming: 0 },
    { id: 'keychain', name: '3D Printed Keychain', price: 150, gaming: 0 },
    { id: 'passA', name: 'Premium Pass A', price: 100, gaming: 2 },
    { id: 'passB', name: 'Premium Pass B', price: 100, gaming: 1.5 },
    { id: 'passC', name: 'Premium Pass C', price: 200, gaming: 2 },
  ];
}
export default async (req: Request) => {
  try {
    const action = new URL(req.url).searchParams.get('action');
    if (req.method !== 'GET' && req.headers.get('origin') !== new URL(req.url).origin && req.headers.get('sec-fetch-site') !== 'same-origin') {
      return reply({ error: 'Request must come from this site.' }, 403);
    }
    if (Number(req.headers.get('content-length')) > 16000) return reply({ error: 'Request too large.' }, 413);
    if (action === 'login' && req.method === 'POST') {
      const { email, password, inviteToken } = await req.json();
      if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
        return reply({ error: 'Enter your admin email and password.' }, 400);
      }
      let recoveredUser: Awaited<ReturnType<typeof login>> | null = null;
      if (inviteToken) {
        if (typeof inviteToken !== 'string') return reply({ error: 'Open a fresh invitation link.' }, 400);
        try {
          await acceptInvite(inviteToken, password);
        } catch (error) {
          // A previous attempt may already have consumed the invitation. Try the
          // supplied credentials once so an accepted invite cannot trap the user.
          const status = (error as { status?: number }).status;
          if (![400, 401, 404, 422].includes(status ?? 0)) throw error;
          try { recoveredUser = await login(email.trim(), password); }
          catch { return reply({ error: 'The invitation could not be accepted. If you already set a password, sign in with it. Otherwise request a fresh invitation and use a password of at least 8 characters.' }, 401); }
        }
      }
      // acceptInvite uses the invitation client; login establishes the server
      // session cookies required by subsequent protected booking requests.
      const user = recoveredUser ?? await login(email.trim(), password);
      if (!user.roles?.includes('admin')) {
        await logout();
        return reply({ error: 'Your account needs the admin role. Ask the site owner to assign it in Identity.' }, 403);
      }
      return reply({ ok: true });
    }
    if (action === 'logout' && req.method === 'POST') { await logout(); return reply({ ok: true }); }
    const db = database();
    if (action === 'availability' && req.method === 'GET') {
      const rows = await db.select({ slotIndex: bookings.slotIndex, gamingSessions: bookings.gamingSessions }).from(bookings);
      const occupied = Array(24).fill(0);
      rows.forEach(b => { if (b.slotIndex !== null) occupied[b.slotIndex] += b.gamingSessions; });
      return reply({ occupied });
    }
    if (action === 'public' && req.method === 'GET') {
      const rows = await db.select().from(bookings).orderBy(desc(bookings.createdAt));
      const publicBookings = rows.map(({ ref, name, items, slotIndex, total, status }) => ({ ref, name, items, slotIndex, total, status }));
      const passes = catalog().filter(product => product.id.startsWith('pass')).map(product => {
        let sold = 0, paid = 0;
        for (const booking of rows) {
          const quantity = booking.items.find(item => item.id === product.id)?.qty ?? 0;
          sold += quantity;
          if (booking.status === 'PAID') paid += quantity;
        }
        return { name: product.name, sold, paid, unpaid: sold - paid };
      });
      return reply({ bookings: publicBookings, passes });
    }
    if (action === 'lookup' && req.method === 'POST') {
      const { contact } = await req.json();
      if (typeof contact !== 'string' || !contact.trim() || contact.length > 100) {
        return reply({ error: 'Enter the email or phone number used to book.' }, 400);
      }
      const value = contact.trim();
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      const isPhone = /^[+()\d\s-]{8,18}$/.test(value) && value.replace(/\D/g, '').length >= 8;
      if (!isEmail && !isPhone) return reply({ error: 'Enter a valid email address or phone number.' }, 400);
      const matches = await db.select().from(bookings).where(
        isEmail
          ? sql`lower(trim(${bookings.contact})) = ${value.toLowerCase()}`
          : sql`regexp_replace(${bookings.contact}, '[^0-9]', '', 'g') = ${value.replace(/\D/g, '')}`,
      ).orderBy(desc(bookings.createdAt));
      return matches.length ? reply({ bookings: matches }) : reply({ error: 'No bookings found. Enter the email or phone number you used when booking.' }, 404);
    }
    if (req.method === 'POST' && !action) {
      const body = await req.json();
      const validText = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
      if (!validText(body.name, 70) || !validText(body.contact, 100) || !['9','10','11','12'].includes(body.className) || !validText(body.section, 12) || !['cash','prepaid'].includes(body.paymentMethod)) {
        return reply({ error: 'Please check your customer details and payment method.' }, 400);
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.contact) && !/^[+()\d\s-]{8,18}$/.test(body.contact)) return reply({ error: 'Enter a valid email address or phone number.' }, 400);
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 8 || !/^[0-9a-f-]{36}$/i.test(body.requestId)) return reply({ error: 'Invalid booking.' }, 400);
      const items: BookingItem[] = [];
      let total = 0, gamingSessions = 0;
      for (const item of body.items) {
        const product = catalog().find(p => p.id === item.id);
        if (!product || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 100 || items.some(p => p.id === item.id)) return reply({ error: 'Invalid cart quantity.' }, 400);
        items.push({ id: product.id, name: product.name, price: product.price, qty: item.qty });
        total += product.price * item.qty;
        gamingSessions += product.gaming * item.qty;
      }
      const slotIndex = gamingSessions ? body.slotIndex : null;
      if (gamingSessions > 4 || (gamingSessions && (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 24))) return reply({ error: 'Choose a gaming slot with enough capacity.' }, 400);
      const ref = 'FAIR-2026-' + body.requestId.toUpperCase();
      const result = await db.transaction(async tx => {
        // Serialize submissions and retries so a slot cannot be overbooked.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(20261110)`);
        const [existing] = await tx.select().from(bookings).where(eq(bookings.ref, ref));
        if (existing) return existing;
        if (slotIndex !== null) {
          const slotBookings = await tx.select().from(bookings).where(eq(bookings.slotIndex, slotIndex));
          if (slotBookings.reduce((n, b) => n + b.gamingSessions, 0) + gamingSessions > 4) return null;
        }
        const [saved] = await tx.insert(bookings).values({ ref, name: body.name.trim(), contact: body.contact.trim(), className: body.className, section: body.section.trim(), items, total, paymentMethod: body.paymentMethod, gamingSessions, slotIndex }).returning();
        return saved;
      });
      return result ? reply({ booking: result }, 201) : reply({ error: 'That slot has just filled up. Please choose another slot.' }, 409);
    }
    const user = await getUser();
    if (!user?.roles?.includes('admin')) return reply({ error: 'Please sign in with an admin account.' }, 401);
    if (req.method === 'GET' && !action) return reply({ bookings: await db.select().from(bookings).orderBy(desc(bookings.createdAt)) });
    if (req.method === 'PATCH' && !action) {
      const { ref, status } = await req.json();
      if (typeof ref !== 'string' || !['PAID','UNPAID'].includes(status)) return reply({ error: 'Invalid status.' }, 400);
      const [booking] = await db.update(bookings).set({ status }).where(eq(bookings.ref, ref)).returning();
      return booking ? reply({ booking }) : reply({ error: 'Booking not found.' }, 404);
    }
    return reply({ error: 'Method not allowed.' }, 405);
  } catch (error) {
    if (error instanceof SyntaxError) return reply({ error: 'Invalid request.' }, 400);
    if (error instanceof Error && error.name === 'MissingIdentityError') {
      return reply({ error: 'Admin sign-in is unavailable. The site owner needs to enable Netlify Identity.' }, 503);
    }
    if (error instanceof Error && error.name === 'AuthError') {
      const status = (error as Error & { status?: number }).status;
      if (/not confirmed|not verified/i.test(error.message)) return reply({ error: 'Confirm your email using the email from Netlify Identity before signing in.' }, 403);
      if (/runtime|endpoint URL/i.test(error.message)) return reply({ error: 'Admin sign-in is not configured correctly on this deployment. Contact the site owner.' }, 503);
      if (status === 429) return reply({ error: 'Too many sign-in attempts. Wait a few minutes and try again.' }, 429);
      if (status && status >= 500) return reply({ error: 'The sign-in service is temporarily unavailable. Try again shortly.' }, 503);
      if (status === 403) return reply({ error: 'Sign-in was refused by Identity. Ask the site owner to check your invitation and account settings.' }, 403);
      if ([400, 401, 404, 422].includes(status ?? 0)) return reply({ error: 'Email or password was not accepted. Use your site Identity account, which is separate from your Netlify dashboard account.' }, 401);
      return reply({ error: 'The sign-in service could not complete the request. Try again shortly or contact the site owner.' }, 503);
    }
    return reply({ error: 'Unable to connect right now. Please try again.' }, 503);
  }
};
export const config = { path: '/api/bookings' };
