// razorpay-webhook payment lifecycle and refunds, end to end through the real
// handler under Node: Deno is shimmed and supabase-js is an in-memory
// database. settle_payment here follows the SQL's state rules (pending →
// confirmed; failed/expired → late, confirmed only if the seats are still
// free, otherwise needs_review; amount mismatch → needs_review) — the SQL
// itself is checked in supabase/tests/payment_retry.test.sql.
// Run: node scripts/test-webhook-payments.mjs
import { register } from 'node:module';
import { createHmac } from 'node:crypto';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('https://esm.sh/@supabase/supabase-js'))
    return { shortCircuit: true, url: 'data:text/javascript,export const createClient = (...a) => globalThis.__createClient(...a);' };
  if (specifier.startsWith('https://esm.sh/qrcode'))
    return { shortCircuit: true, url: 'data:text/javascript,export default { toDataURL: async (t) => "data:image/png;base64," + btoa(t) };' };
  return next(specifier, context);
}`));

const SECRET = 'whsec_local_payments_0123';
const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test', RAZORPAY_WEBHOOK_SECRET: SECRET };
let handler;
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };

// ---------------------------------------------------------------- database
const db = {};
const faults = { bookingUpdate: 0 };
const path = (row, key) => {
  const m = key.match(/^(\w+)((?:->\w+)*)->>(\w+)$/);
  if (!m) return row[key];
  let v = row[m[1]];
  for (const k of [...m[2].split('->').filter(Boolean), m[3]]) v = v?.[k];
  return v == null ? v : String(v);
};
const filtered = (table, filters) => db[table].filter((r) => filters.every((f) => f(r)));
const builder = (table) => {
  const filters = [];
  const q = {
    eq: (c, v) => { filters.push((r) => path(r, c) === v); return q; },
    in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return q; },
    lt: (c, v) => { filters.push((r) => r[c] < v); return q; },
    maybeSingle: async () => { const r = filtered(table, filters); return { data: r[0] ? structuredClone(r[0]) : null, error: null }; },
    single: async () => { const r = filtered(table, filters); return r.length === 1 ? { data: structuredClone(r[0]), error: null } : { data: null, error: { code: 'PGRST116' } }; },
    then: (ok, ko) => Promise.resolve({ data: filtered(table, filters).map((r) => structuredClone(r)), error: null }).then(ok, ko),
  };
  return q;
};
const capacityTaken = (eventId, exceptId) => db.bookings.filter((b) => b.event_id === eventId && b.id !== exceptId && ['pending', 'confirmed'].includes(b.status)).reduce((a, b) => a + b.quantity, 0);
const rpc = {
  settle_payment: ({ p_order_id, p_payment_id, p_amount_paise }) => {
    const b = db.bookings.find((x) => x.razorpay_order_id === p_order_id);
    if (!b) return { result: 'not_found' };
    if (b.status === 'confirmed') return { result: 'already_confirmed', booking_id: b.id };
    let reason = null; let late = false;
    if (p_amount_paise != null && p_amount_paise !== b.amount * 100) reason = 'amount mismatch';
    else if (['cancelled', 'refunded'].includes(b.status)) reason = 'cancelled';
    else if (['expired', 'failed'].includes(b.status)) {
      late = true;
      const ev = db.events.find((e) => e.id === b.event_id);
      if (capacityTaken(b.event_id, b.id) + b.quantity > ev.capacity) reason = 'seats gone';
    } else if (b.status !== 'pending') reason = `unexpected ${b.status}`;
    if (reason) { Object.assign(b, { razorpay_payment_id: p_payment_id, payment_status: 'needs_review' }); return { result: 'needs_review', booking_id: b.id, reason }; }
    Object.assign(b, { status: 'confirmed', razorpay_payment_id: p_payment_id, payment_status: 'captured' });
    db.tickets.push({ booking_id: b.id });
    return { result: 'confirmed', booking_id: b.id, late };
  },
  record_webhook_failure: ({ p_event_id, p_error }) => { const e = db.payment_webhook_events.find((x) => x.event_id === p_event_id); if (e) e.processing_error = p_error; return null; },
};
globalThis.__createClient = () => ({
  rpc: async (name, args) => ({ data: rpc[name](args), error: null }),
  from: (table) => ({
    select: () => builder(table),
    insert: (row) => ({ then: (ok, ko) => {
      let result = { error: null };
      if (table === 'payment_webhook_events' && db[table].some((r) => r.event_id === row.event_id)) result = { error: { code: '23505', message: 'duplicate key' } };
      else if (table === 'email_outbox' && db[table].some((r) => r.dedupe_key === row.dedupe_key)) result = { error: { code: '23505', message: 'duplicate key' } };
      else db[table].push(structuredClone({ status: 'queued', ...row }));
      return Promise.resolve(result).then(ok, ko);
    } }),
    update: (patch) => {
      const filters = [];
      const chain = {
        eq: (c, v) => { filters.push((r) => path(r, c) === v); return chain; },
        in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return chain; },
        lt: (c, v) => { filters.push((r) => r[c] < v); return chain; },
        then: (ok, ko) => {
          if (table === 'bookings' && faults.bookingUpdate > 0) { faults.bookingUpdate--; return Promise.resolve({ error: { message: 'connection lost' } }).then(ok, ko); }
          for (const r of filtered(table, filters)) Object.assign(r, patch);
          return Promise.resolve({ error: null }).then(ok, ko);
        },
      };
      return chain;
    },
  }),
});
const logs = [];
for (const level of ['log', 'warn', 'error']) console[level] = (...a) => logs.push(a.map(String).join(' '));
await import('../supabase/functions/razorpay-webhook/index.ts');

const deliver = async (event, entities) => {
  const raw = JSON.stringify({ event, payload: entities, created_at: Date.now() });
  const res = await handler(new Request('https://fn.example/razorpay-webhook', {
    method: 'POST', headers: { 'X-Razorpay-Signature': createHmac('sha256', SECRET).update(raw).digest('hex') }, body: raw }));
  return { status: res.status, text: await res.text(), raw };
};
const redeliver = async (raw) => {
  const res = await handler(new Request('https://fn.example/razorpay-webhook', {
    method: 'POST', headers: { 'X-Razorpay-Signature': createHmac('sha256', SECRET).update(raw).digest('hex') }, body: raw }));
  return { status: res.status, text: await res.text() };
};
const payment = (id, order, amount = 118000, extra = {}) => ({ payment: { entity: { id, order_id: order, amount, ...extra } } });
const refund = (id, paymentId, amount, withPayment) => ({ refund: { entity: { id, payment_id: paymentId, amount } }, ...(withPayment ? { payment: { entity: { id: paymentId, amount: 118000, ...withPayment } } } : {}) });
const reset = () => {
  Object.assign(db, {
    events: [{ id: 'ev-1', capacity: 2 }],
    bookings: [
      { id: 'bk-1', event_id: 'ev-1', user_id: 'u-1', status: 'pending', quantity: 2, amount: 1180, razorpay_order_id: 'order_1', razorpay_payment_id: null, payment_status: 'created', refunded_amount: 0 },
    ],
    tickets: [], payment_webhook_events: [], email_outbox: [],
    profiles: [{ id: 'u-1', email: 'buyer@x.test' }],
  });
  faults.bookingUpdate = 0;
};
const bk = (id = 'bk-1') => db.bookings.find((b) => b.id === id);
let failed = 0;
const check = (cond, label) => { process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${label}\n`); if (!cond) failed++; };
let r;

process.stdout.write('--- A. a failed attempt keeps the hold; the retry on the same order confirms\n');
reset();
r = await deliver('payment.failed', payment('pay_fail_1', 'order_1'));
check(r.status === 200 && bk().status === 'pending' && bk().payment_status === 'failed', 'payment.failed → hold still pending (payment_status failed), 200');
check(capacityTaken('ev-1') === 2, 'its seats stay held — nobody else can take them mid-retry');
db.bookings.push({ id: 'bk-2', event_id: 'ev-1', user_id: 'u-2', status: 'pending', quantity: 2, amount: 1180, razorpay_order_id: 'order_2', payment_status: 'created', refunded_amount: 0 });
check(capacityTaken('ev-1', 'bk-2') + 2 > db.events[0].capacity, 'a second buyer for the same 2 seats would be SOLD_OUT (capacity counts the pending hold)');
db.bookings.pop();
r = await deliver('payment.authorized', payment('pay_ok_1', 'order_1'));
check(bk().payment_status === 'authorized', 'the retry is authorized (allowed after a failed attempt)');
r = await deliver('payment.captured', payment('pay_ok_1', 'order_1'));
check(r.status === 200 && bk().status === 'confirmed' && bk().payment_status === 'captured' && db.tickets.length === 1, 'the retry is captured → confirmed, tickets issued — not needs_review');
check(db.email_outbox.length === 1, 'ticket email queued once');
r = await deliver('payment.failed', payment('pay_fail_late', 'order_1'));
check(r.status === 200 && bk().status === 'confirmed' && bk().payment_status === 'captured', 'a stale payment.failed arriving after the capture changes nothing');

process.stdout.write('--- B. what the old release caused (simulated): seats taken during the retry → needs_review\n');
reset();
Object.assign(bk(), { status: 'failed', payment_status: 'failed' });   // what payment.failed used to do
db.bookings.push({ id: 'bk-2', event_id: 'ev-1', user_id: 'u-2', status: 'confirmed', quantity: 2, amount: 1180, razorpay_order_id: 'order_2', payment_status: 'captured', refunded_amount: 0 });
r = await deliver('payment.captured', payment('pay_ok_1', 'order_1'));
check(bk().payment_status === 'needs_review' && bk().status === 'failed', 'with the hold released and the seats resold, a successful retry needed a refund (the case now prevented)');

process.stdout.write('--- C. failed attempt, then the hold simply expires; a late payment follows the existing rules\n');
reset();
await deliver('payment.failed', payment('pay_fail_1', 'order_1'));
Object.assign(bk(), { status: 'expired' });                            // expire_stale_bookings after the timeout
r = await deliver('payment.captured', payment('pay_ok_late', 'order_1'));
check(bk().status === 'confirmed', 'seats still free → late payment accepted (settle_payment unchanged)');
r = await deliver('payment.failed', payment('pay_fail_2', 'order_x'));
check(r.status === 200, 'payment.failed for an unknown order → 200, nothing changed');

process.stdout.write('--- D. duplicates and transient failures\n');
reset();
r = await deliver('payment.failed', payment('pay_fail_1', 'order_1'));
const again = await redeliver(r.raw);
check(again.status === 200 && again.text === 'ok (duplicate)', 'the same payment.failed delivered twice → duplicate');
reset(); faults.bookingUpdate = 1;
r = await deliver('payment.failed', payment('pay_fail_1', 'order_1'));
check(r.status === 500 && bk().payment_status === 'created', 'payment.failed whose update fails → 500, Razorpay retries');
const retry = await redeliver(r.raw);
check(retry.status === 200 && bk().payment_status === 'failed' && bk().status === 'pending', 'the retry processes it');

process.stdout.write('--- E. refunds: each partial refund is its own event; totals only go up\n');
reset();
await deliver('payment.captured', payment('pay_ok_1', 'order_1'));
check(bk().status === 'confirmed', 'booking paid (₹1,180)');
const p1 = await deliver('refund.processed', refund('rfnd_1', 'pay_ok_1', 30000));
check(p1.status === 200 && bk().refunded_amount === 300 && bk().payment_status === 'partially_refunded', 'partial refund #1 ₹300 → refunded ₹300, partially_refunded');
const p2 = await deliver('refund.processed', refund('rfnd_2', 'pay_ok_1', 40000));
check(p2.status === 200 && bk().refunded_amount === 700 && bk().payment_status === 'partially_refunded', 'partial refund #2 ₹400 on the same payment → processed (was a "duplicate") → ₹700');
check(db.payment_webhook_events.filter((e) => e.event_type === 'refund.processed').length === 2, 'two distinct events recorded (keyed by refund id)');
const dup = await redeliver(p2.raw);
check(dup.text === 'ok (duplicate)' && bk().refunded_amount === 700, 'refund #2 delivered again → duplicate, still ₹700 (never counted twice)');
const created = await deliver('refund.created', refund('rfnd_3', 'pay_ok_1', 48000));
check(created.status === 200 && bk().refunded_amount === 700, 'refund.created (not yet processed) → recorded, amounts unchanged');
const p3 = await deliver('refund.processed', refund('rfnd_3', 'pay_ok_1', 48000));
check(p3.status === 200 && bk().refunded_amount === 1180 && bk().payment_status === 'refunded', 'final refund ₹480 → ₹1,180, refunded');
const dupFull = await redeliver(p3.raw);
check(dupFull.text === 'ok (duplicate)' && bk().refunded_amount === 1180 && bk().payment_status === 'refunded', 'full refund delivered again → unchanged');
check(bk().status === 'confirmed' && db.tickets.length === 1, 'the webhook never voids tickets or cancels the booking (admins record refunds)');

process.stdout.write('--- F. refund ordering and Razorpay\'s own running total\n');
reset();
await deliver('payment.captured', payment('pay_ok_1', 'order_1'));
await deliver('refund.processed', refund('rfnd_b', 'pay_ok_1', 40000, { amount_refunded: 70000 }));
check(bk().refunded_amount === 700, 'refund #2 arrives first carrying Razorpay\'s running total ₹700 → ₹700');
await deliver('refund.processed', refund('rfnd_a', 'pay_ok_1', 30000, { amount_refunded: 30000 }));
check(bk().refunded_amount === 700 && bk().payment_status === 'partially_refunded', 'the older refund #1 (running total ₹300) arrives later → stays ₹700, never lowered');
reset();
await deliver('payment.captured', payment('pay_ok_1', 'order_1'));
faults.bookingUpdate = 1;
const t = await deliver('refund.processed', refund('rfnd_t', 'pay_ok_1', 30000));
check(t.status === 500 && bk().refunded_amount === 0, 'refund mirror fails transiently → 500, nothing half-written');
const t2 = await redeliver(t.raw);
check(t2.status === 200 && bk().refunded_amount === 300, 'Razorpay\'s retry applies it once');
const orphan = await deliver('refund.processed', refund('rfnd_o', 'pay_unknown', 10000));
check(orphan.status === 200, 'refund for a payment with no booking → acknowledged, logged');
const noId = await deliver('refund.processed', { refund: { entity: { payment_id: 'pay_ok_1', amount: 100 } } });
check(noId.status === 200 && bk().refunded_amount === 300, 'refund event without a refund id → skipped (nothing stable to deduplicate on)');

process.stdout.write('--- G. nothing sensitive in responses\n');
check(!logs.some((l) => l.includes(SECRET)), 'webhook secret never logged');

process.stdout.write(failed ? `${failed} FAILED\n` : 'ALL WEBHOOK PAYMENT CHECKS PASSED\n');
process.exit(failed ? 1 : 0);
