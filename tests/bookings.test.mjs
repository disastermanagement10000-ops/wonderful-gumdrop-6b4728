import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

async function harness(identity = {}) {
  const rows = [];
  let user = null;
  const columns = Object.fromEntries(['ref','contact','slotIndex','gamingSessions','createdAt'].map(k=>[k,k]));
  const query = () => {
    let selection = [...rows];
    return {
      from(){return this;}, where(condition){selection=selection.filter(r=>typeof condition==='function'?condition(r):r[condition[0]]===condition[1]);return this;},
      orderBy(){selection.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return this;},
      then(resolve,reject){return Promise.resolve(selection).then(resolve,reject);}
    };
  };
  let queue = Promise.resolve();
  const db = {
    select: query, execute: async()=>{},
    insert:()=>({values:value=>({returning:async()=>{const r={...value,status:'UNPAID',createdAt:new Date().toISOString()};rows.push(r);return [r];}})}),
    update:()=>({set:value=>({where:([k,v])=>({returning:async()=>{const row=rows.find(r=>r[k]===v);if(row)Object.assign(row,value);return row?[row]:[];}})})}),
    transaction(fn){const next=queue.then(()=>fn(db));queue=next.catch(()=>{});return next;}
  };
  const context=vm.createContext({Request,Response,URL,console,Error});
  const mocks={
    '@netlify/identity':{getUser:async()=>user,login:async()=>user,logout:async()=>{user=null;},acceptInvite:async()=>user,...identity},
    'drizzle-orm':{desc:x=>x,eq:(k,v)=>[k,v],and:(...conditions)=>r=>conditions.every(c=>typeof c==='function'?c(r):r[c[0]]===c[1]),sql:(parts,...values)=>parts.join('').includes('lower(')?r=>r[values[0]].trim().toLowerCase()===values[1]:parts.join('').includes('regexp_replace(')?r=>r[values[0]].replace(/\D/g,'')===values[1]:''},
    '../../db/index.js':{database:()=>db}, '../../db/schema.js':{bookings:columns}
  };
  const source=ts.transpileModule(fs.readFileSync('netlify/functions/bookings.mts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
  const module=new vm.SourceTextModule(source,{context});
  await module.link(name=>{const values=mocks[name];return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v] of Object.entries(values))this.setExport(k,v);},{context});});
  await module.evaluate();
  return { rows, setUser:value=>{user=value;}, request:async(method='GET',body,action='',headers={})=>module.namespace.default(new Request('https://example.test/api/bookings'+(action?'?action='+action:''),{method,headers:{Origin:'https://example.test','Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})})) };
}
function booking(requestId='00000000-0000-4000-8000-000000000001') {return {requestId,name:'Test Customer',contact:'test@example.com',className:'10',section:'A',items:[{id:'gaming',qty:2}],slotIndex:0,paymentMethod:'cash',total:1,status:'PAID'};}
test('a customer booking is centrally saved with trusted totals and listing restricted to admins',async()=>{
 const h=await harness();const response=await h.request('POST',booking());assert.equal(response.status,201);
 const {booking:saved}=await response.json();assert.equal(saved.total,70);assert.equal(saved.status,'UNPAID');
 assert.equal((await h.request()).status,401);
 h.setUser({roles:['member']});assert.equal((await h.request()).status,401);
 h.setUser({roles:['admin']});const list=await (await h.request()).json();assert.equal(list.bookings[0].contact,'test@example.com');
 assert.equal((await h.request('PATCH',{ref:saved.ref,status:'PAID'})).status,200);assert.equal(h.rows[0].status,'PAID');
 const availability=await (await h.request('GET',undefined,'availability')).json();assert.equal(availability.occupied[0],2);assert.equal(availability.bookings,undefined);
});
test('retries do not duplicate bookings and competing bookings respect slot capacity',async()=>{
 const h=await harness();await h.request('POST',booking());await h.request('POST',booking());assert.equal(h.rows.length,1);
 const outcomes=await Promise.all([h.request('POST',booking('00000000-0000-4000-8000-000000000002')),h.request('POST',booking('00000000-0000-4000-8000-000000000003'))]);
 assert.deepEqual(outcomes.map(r=>r.status),[201,409]);assert.equal(h.rows.length,2);
});
test('invalid requests cannot create bookings or update payment status',async()=>{
 const h=await harness();assert.equal((await h.request('POST',{...booking(),items:[{id:'gaming',qty:-1}]})).status,400);
 assert.equal((await h.request('POST',{...booking(),slotIndex:null})).status,400);
 assert.equal((await h.request('PATCH',{ref:'missing',status:'PAID'})).status,401);assert.equal(h.rows.length,0);
});

test('invitation acceptance establishes a login session and still requires the admin role',async()=>{
 const calls=[];
 const h=await harness({acceptInvite:async()=>{calls.push('invite');return {roles:['admin']};},login:async()=>{calls.push('login');return {roles:['admin']};}});
 assert.equal((await h.request('POST',{email:'admin@example.test',password:'example-password',inviteToken:'test-invitation'},'login')).status,200);
 assert.deepEqual(calls,['invite','login']);
 const member=await harness({login:async()=>({roles:['member']})});
 assert.equal((await member.request('POST',{email:'member@example.test',password:'example-password'},'login')).status,403);
});
test('a consumed invitation can recover using valid existing credentials',async()=>{
 const h=await harness({acceptInvite:async()=>{throw Object.assign(new Error('consumed'),{name:'AuthError',status:400});},login:async()=>({roles:['admin']})});
 assert.equal((await h.request('POST',{email:'admin@example.test',password:'example-password',inviteToken:'used-invitation'},'login')).status,200);
});
test('auth errors give safe guidance without echoing provider errors',async()=>{
 for(const [status,providerMessage,expected] of [[400,'invalid credentials','Email or password'],[403,'Email not confirmed','Confirm your email'],[429,'rate limit','Too many'],[undefined,'Server-side auth requires Netlify Functions runtime','not configured correctly']]){
  const h=await harness({login:async()=>{throw Object.assign(new Error(providerMessage),{name:'AuthError',status});}});
  const response=await h.request('POST',{email:'admin@example.test',password:'example-password'},'login');
  assert.match((await response.json()).error,new RegExp(expected));
 }
});
test('same-origin browser requests survive proxy origin differences while cross-site writes are blocked',async()=>{
 const h=await harness();
 assert.equal((await h.request('POST',booking(),' ',{Origin:'https://other.test','sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await h.request('POST',booking(),'',{Origin:'https://public.test','sec-fetch-site':'same-origin'})).status,201);
});

test('customers can look up only a matching booking and cannot change payment status',async()=>{
 const h=await harness();const {booking:saved}=await (await h.request('POST',booking())).json();
 const lookup={contact:' TEST@EXAMPLE.COM '};
 let response=await h.request('POST',lookup,'lookup');assert.equal(response.status,200);
 assert.equal((await response.json()).bookings[0].total,70);
 assert.equal((await h.request('POST',{...lookup,contact:'other@example.com'},'lookup')).status,404);
 assert.equal((await h.request('POST',{contact:''},'lookup')).status,400);
 assert.equal((await h.request('PATCH',{ref:saved.ref,status:'PAID'})).status,401);
 h.setUser({roles:['member']});
 assert.equal((await h.request('PATCH',{ref:saved.ref,status:'PAID'})).status,401);
 assert.equal(h.rows[0].status,'UNPAID');
 h.setUser({roles:['admin']});await h.request('PATCH',{ref:saved.ref,status:'PAID'});
 h.setUser(null);response=await h.request('POST',lookup,'lookup');
 assert.equal((await response.json()).bookings[0].status,'PAID');
 assert.equal((await h.request()).status,401);
});

test('public overview lists bookings and pass counts without exposing contacts or permitting updates',async()=>{
 const h=await harness();
 let data=await (await h.request('GET',undefined,'public')).json();
 assert.deepEqual(data.bookings,[]);assert.equal(data.passes.length,3);assert.ok(data.passes.every(p=>p.sold===0));
 await h.request('POST',{...booking(),items:[{id:'passA',qty:2}]});
 await h.request('POST',{...booking('00000000-0000-4000-8000-000000000002'),items:[{id:'passB',qty:1}],slotIndex:1});
 h.setUser({roles:['admin']});await h.request('PATCH',{ref:h.rows[0].ref,status:'PAID'});h.setUser(null);
 const response=await h.request('GET',undefined,'public');assert.equal(response.status,200);
 assert.equal(response.headers.get('cache-control'),'no-store');data=await response.json();
 assert.equal(data.bookings.length,2);assert.equal(data.bookings.find(b=>b.ref===h.rows[0].ref).status,'PAID');
 assert.ok(data.bookings.every(b=>!('contact' in b)&&!('className' in b)&&!('section' in b)));
 assert.deepEqual(data.passes.map(p=>[p.sold,p.paid,p.unpaid]),[[2,2,0],[1,0,1],[0,0,0]]);
 assert.equal((await h.request('PATCH',{ref:h.rows[0].ref,status:'UNPAID'},'public')).status,401);
 h.setUser({roles:['member']});assert.equal((await h.request('PATCH',{ref:h.rows[0].ref,status:'UNPAID'})).status,401);
 assert.equal(h.rows[0].status,'PAID');
});

test('contact lookup returns all matching bookings and normalizes phone formatting',async()=>{
 const h=await harness();
 await h.request('POST',{...booking(),contact:'+91 (98765) 43210'});
 await h.request('POST',{...booking('00000000-0000-4000-8000-000000000002'),contact:'+919876543210',slotIndex:1});
 await h.request('POST',{...booking('00000000-0000-4000-8000-000000000003'),contact:'other@example.com',slotIndex:2});
 const response=await h.request('POST',{contact:'91 98765 43210'},'lookup');
 assert.equal(response.status,200);
 const data=await response.json();assert.equal(data.bookings.length,2);
 assert.ok(data.bookings.every(b=>b.contact.replace(/\D/g,'')==='919876543210'));
 assert.equal((await h.request('POST',{contact:'9876543210'},'lookup')).status,404);
 for(const contact of [null,123,'invalid','a'.repeat(101),'--------']){
  assert.equal((await h.request('POST',{contact},'lookup')).status,400);
 }
});
