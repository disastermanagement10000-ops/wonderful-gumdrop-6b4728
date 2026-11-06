import { pgTable, text, jsonb, integer, real, timestamp } from 'drizzle-orm/pg-core';
export type BookingItem = { id: string; name: string; qty: number; price: number };
export const bookings = pgTable('bookings', {
  ref: text().primaryKey(),
  name: text().notNull(), contact: text().notNull(),
  className: text('class_name').notNull(), section: text().notNull(),
  items: jsonb().$type<BookingItem[]>().notNull(), total: integer().notNull(),
  paymentMethod: text('payment_method').notNull(), status: text().notNull().default('UNPAID'),
  slotIndex: integer('slot_index'), gamingSessions: real('gaming_sessions').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});
