// razorpay-create-order and the one-hold-per-account (0037) and past-session (0038) rules, through the
// real handler under Node: Deno is shimmed, supabase-js is a stub whose
// create_pending_booking answer is scripted per case, and the Razorpay Orders
// API is a stubbed fetch that records every call. The database rule itself is
// tested in supabase/tests/pending_holds.test.sql and
// scripts/test-pending-holds-concurrency.sh.
// Run: node scripts/test-create-order.mjs
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('https://esm.sh/@supabase/supabase-js'))
    return { shortCircuit: true, url: 'data:text/javascript,export const createClient = (...a) => globalThis.__createClient(...a);' };
  return next(specifier, context);
}`));

const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'rzp_test_secret_value', SITE_URL: 'https://tangy.example' };
let handler;
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };

let rpcAnswer;            // what create_pending_booking returns this time
const updates = [];       // bookings updates the function makes
const razorpayCalls = [];
globalThis.__createClient = () => ({
  auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'u@x.test' } }, error: null }) },
  rpc: async () => rpcAnswer,
  from: (table) => {
    const chain = {
      select: () => chain, eq: () => chain, gt: () => chain,
      single: async () => ({ data: { id: 'evt-1', price: 500, status: 'on-sale', booking_min_quantity: 1, booking_max_quantity: 4 }, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      update: (patch) => { updates.push({ table, patch }); return { eq: async () => ({ error: null }) }; },
    };
    return chain;
  },
});
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.razorpay.com/v1/orders') throw new Error(`unexpected fetch ${url}`);
  razorpayCalls.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ id: `order_new_${razorpayCalls.length}` }), { status: 200 });
};
const quiet = (fn) => { const e = console.error; console.error = () => {}; return fn().finally(() => { console.error = e; }); };
await import('../supabase/functions/razorpay-create-order/index.ts');

const body = { eventId: 'evt-1', quantity: 2, tierId: 'gen', attendeeName: 'Asha', attendeeEmail: 'asha@x.test', attendeePhone: '9876543210', attendeeNames: ['Asha', 'Ravi'], details: {} };
const call = async () => {
  updates.length = 0; razorpayCalls.length = 0;
  const res = await quiet(() => handler(new Request('https://fn.example/razorpay-create-order', {
    method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json', Origin: 'https://tangy.example' }, body: JSON.stringify(body),
  })));
  return { status: res.status, json: await res.json() };
};
let failed = 0;
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; };
let r;

rpcAnswer = { data: { id: 'bk-1', amount: 1180, razorpay_order_id: null }, error: null };
r = await call();
check(r.status === 200 && razorpayCalls.length === 1 && razorpayCalls[0].amount === 118000 && r.json.order_id === 'order_new_1' && r.json.booking_id === 'bk-1',
  'new hold → one Razorpay order at the database price, order id attached');
check(updates.some((u) => u.table === 'bookings' && u.patch.razorpay_order_id === 'order_new_1'), 'the order id is stored on the hold');

rpcAnswer = { data: { id: 'bk-1', amount: 1180, razorpay_order_id: 'order_new_1' }, error: null };
r = await call();
check(r.status === 200 && razorpayCalls.length === 0 && r.json.order_id === 'order_new_1' && r.json.booking_id === 'bk-1' && r.json.amount === 118000 && r.json.resumed === true,
  'resumed hold (refresh / retry) → the same order again, no new Razorpay order');
check(updates.length === 0, 'a resumed hold is not modified (never marked failed)');

rpcAnswer = { data: null, error: { code: 'P0001', message: 'HOLD_IN_PROGRESS: A payment for this session is already being processed. Check your bookings in a minute before trying again.' } };
r = await call();
check(r.status === 409 && /already being processed/.test(r.json.error) && !/HOLD_IN_PROGRESS/.test(r.json.error) && razorpayCalls.length === 0,
  'payment in flight → 409 with a readable message, no Razorpay order');

rpcAnswer = { data: null, error: { code: 'P0001', message: 'RATE_LIMITED: Too many checkout attempts. Please wait a few minutes and try again.' } };
r = await call();
check(r.status === 429 && /Too many checkout attempts/.test(r.json.error) && razorpayCalls.length === 0, 'throttled → 429, no Razorpay order');

rpcAnswer = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "bookings_one_active_hold"' } };
r = await call();
check(r.status === 409 && /already in progress/.test(r.json.error) && !/bookings_one_active_hold/.test(r.json.error), 'unique-index backstop → 409, constraint name not leaked');

// A direct API call for a session that has already happened, while its status
// still says on-sale: the function's own status check passes, the database
// refuses (0038).
rpcAnswer = { data: null, error: { code: 'P0001', message: 'EVENT_CLOSED: This session has already taken place.' } };
r = await call();
check(r.status === 409 && r.json.error === 'This session has already taken place.' && razorpayCalls.length === 0 && updates.length === 0,
  'past session (still on-sale) → 409 "already taken place", no Razorpay order, nothing written');

rpcAnswer = { data: null, error: { code: 'P0001', message: 'SOLD_OUT' } };
r = await call();
check(r.status === 409 && /Not enough tickets/.test(r.json.error), 'sold out unchanged (409)');

console.log(failed ? `${failed} FAILED` : 'ALL CREATE-ORDER CHECKS PASSED');
process.exit(failed ? 1 : 0);
