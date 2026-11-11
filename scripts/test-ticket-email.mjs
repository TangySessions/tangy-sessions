// Ticket email delivery, end to end through the real Edge Function handlers
// (razorpay-verify-payment, razorpay-webhook, send-ticket-email,
// send-notification-emails) under Node: Deno is shimmed, supabase-js is an
// in-memory database that reproduces the SQL these flows rely on (unique
// email_outbox.dedupe_key and payment_webhook_events.event_id,
// claim_email_batch, complete_email, settle_payment's confirmed /
// already_confirmed results — the real functions are checked against the same
// behaviour in supabase/tests/ticket_email_outbox.test.sql), and Resend is a
// stubbed fetch whose sent mail is recorded.
// Run: node scripts/test-ticket-email.mjs
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

const KEY_SECRET = 'rzp_key_secret_local_0123';
const WEBHOOK_SECRET = 'whsec_local_0123456789';
const CRON = 'cron_secret_local_0123';
const env = {
  SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon-test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
  RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET, RESEND_API_KEY: 're_test', CRON_SECRET: CRON,
  SITE_URL: 'https://tangy.example',
};
const handlers = {};
let loading = null;
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handlers[loading] = h; } };

// ---------------------------------------------------------------- database
const db = {};
let uid = 0;
const id = () => `00000000-0000-0000-0000-${String(++uid).padStart(12, '0')}`;
const reset = () => {
  Object.assign(db, { bookings: [], tickets: [], events: [], profiles: [], email_outbox: [], payment_webhook_events: [] });
};
const faults = { outboxInsert: 0 }; // number of upcoming email_outbox inserts to fail
const UNIQUE = { email_outbox: 'dedupe_key', payment_webhook_events: 'event_id' };

const query = (table) => {
  const filters = [];
  const match = (r) => filters.every(([c, v]) => r[c] === v);
  const rows = () => db[table].filter(match);
  const q = {
    eq: (c, v) => { filters.push([c, v]); return q; },
    order: () => q,
    single: async () => { const r = rows(); return r.length === 1 ? { data: { ...r[0] }, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }; },
    maybeSingle: async () => { const r = rows(); return { data: r[0] ? { ...r[0] } : null, error: null }; },
    then: (ok, ko) => Promise.resolve({ data: rows().map((r) => ({ ...r })), error: null }).then(ok, ko),
  };
  return q;
};

const rpc = {
  settle_payment: ({ p_order_id, p_payment_id }) => {
    const b = db.bookings.find((x) => x.razorpay_order_id === p_order_id);
    if (!b) return { result: 'not_found' };
    if (b.status === 'confirmed') return { result: 'already_confirmed', booking_id: b.id };
    Object.assign(b, { status: 'confirmed', razorpay_payment_id: p_payment_id, razorpay_signature_verified: true, payment_status: 'captured' });
    if (!db.tickets.some((t) => t.booking_id === b.id)) {
      for (let i = 1; i <= b.quantity; i++) db.tickets.push({ id: id(), booking_id: b.id, ticket_number: `${b.registration_code}-0${i}`, attendee_name: `Guest ${i}` });
    }
    return { result: 'confirmed', booking_id: b.id };
  },
  claim_email_batch: ({ p_limit }) => {
    const now = Date.now();
    const picked = db.email_outbox
      .filter((o) => (o.status === 'queued' || (o.status === 'sending' && now - o.locked_at > 600000)) && o.attempts < 5)
      .slice(0, p_limit);
    for (const o of picked) Object.assign(o, { status: 'sending', locked_at: now, attempts: o.attempts + 1 });
    return picked.map((o) => ({ ...o }));
  },
  complete_email: ({ p_id, p_ok, p_error }) => {
    const o = db.email_outbox.find((x) => x.id === p_id);
    Object.assign(o, { status: p_ok ? 'sent' : o.attempts >= 5 ? 'failed' : 'queued', sent_at: p_ok ? Date.now() : null, last_error: p_error ?? null, locked_at: null });
    return null;
  },
  record_webhook_failure: ({ p_event_id, p_error }) => {
    const e = db.payment_webhook_events.find((x) => x.event_id === p_event_id);
    if (e) e.processing_error = p_error;
    return null;
  },
};

globalThis.__createClient = (_url, _key, opts) => ({
  auth: {
    getUser: async () => {
      const token = (opts?.global?.headers?.Authorization || '').replace('Bearer ', '');
      const p = db.profiles.find((x) => `tok-${x.id}` === token);
      return p ? { data: { user: { id: p.id, email: p.email } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
    },
  },
  rpc: async (name, args) => ({ data: rpc[name](args), error: null }),
  from: (table) => ({
    select: () => query(table),
    insert: (row) => ({
      then: (ok, ko) => {
        let result = { error: null };
        if (table === 'email_outbox' && faults.outboxInsert > 0) { faults.outboxInsert--; result = { error: { code: '08006', message: 'connection lost' } }; }
        else if (UNIQUE[table] && db[table].some((r) => r[UNIQUE[table]] === row[UNIQUE[table]])) result = { error: { code: '23505', message: 'duplicate key' } };
        else db[table].push({ id: id(), status: 'queued', attempts: 0, processed: false, ...row });
        return Promise.resolve(result).then(ok, ko);
      },
    }),
    update: (patch) => {
      const filters = [];
      const chain = {
        eq: (c, v) => { filters.push([c, v]); return chain; },
        then: (ok, ko) => {
          for (const r of db[table]) if (filters.every(([c, v]) => r[c] === v)) Object.assign(r, patch);
          return Promise.resolve({ error: null }).then(ok, ko);
        },
      };
      return chain;
    },
  }),
});

// ---------------------------------------------------------------- Resend stub
const mail = [];
let resendFails = false;
const logs = [];
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url}`);
  if (resendFails) return new Response('provider down', { status: 503 });
  const body = JSON.parse(init.body);
  mail.push({ to: body.to[0], subject: body.subject, attachments: (body.attachments || []).length, html: body.html });
  return new Response('{"id":"em_1"}', { status: 200 });
};
for (const level of ['log', 'warn', 'error']) console[level] = (...a) => logs.push(a.map(String).join(' '));
const print = (s) => process.stdout.write(s + '\n');

// ---------------------------------------------------------------- helpers
for (const name of ['razorpay-verify-payment', 'razorpay-webhook', 'send-ticket-email', 'send-notification-emails']) {
  loading = name; await import(`../supabase/functions/${name}/index.ts`); loading = null;
}
const call = async (name, body, headers = {}) => {
  const res = await handlers[name](new Request(`https://fn.example/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, text, json };
};
const verify = (bookingId, orderId, paymentId, user) => call('razorpay-verify-payment', {
  booking_id: bookingId, razorpay_order_id: orderId, razorpay_payment_id: paymentId,
  razorpay_signature: createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex'),
}, { Authorization: `Bearer tok-${user}` });
const webhook = (event, orderId, paymentId, amount = 118000) => {
  const raw = JSON.stringify({ event, payload: { payment: { entity: { id: paymentId, order_id: orderId, amount } } } });
  return call('razorpay-webhook', raw, { 'X-Razorpay-Signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') });
};
const drain = () => call('send-notification-emails', {}, { 'x-cron-secret': CRON });
const ticketEmail = (bookingId, user, force = false) => call('send-ticket-email', { booking_id: bookingId, force }, { Authorization: `Bearer tok-${user}` });

let customer, admin, stranger, event;
const newBooking = (n) => {
  const b = { id: id(), registration_code: `TS-T${n}`, user_id: customer, event_id: event, attendee_name: 'Asha', attendee_email: 'typed@elsewhere.test',
    quantity: 2, amount: 1180, status: 'pending', razorpay_order_id: `order_${n}`, razorpay_signature_verified: false,
    payment_status: 'created', ticket_email_status: 'pending', group_token: `grp-${n}`, source: 'online' };
  db.bookings.push(b);
  return b;
};
const booking = (b) => db.bookings.find((x) => x.id === b.id);
const rowsFor = (b) => db.email_outbox.filter((o) => o.dedupe_key === `ticket.confirmed:${b.id}`);

let failed = 0;
const check = (cond, label) => { print(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; };
const fresh = () => {
  reset(); mail.length = 0; resendFails = false; faults.outboxInsert = 0;
  customer = id(); admin = id(); stranger = id(); event = id();
  db.profiles.push({ id: customer, email: 'asha@customer.test', full_name: 'Asha', role: 'patron', is_active: true },
    { id: admin, email: 'ops@tangy.test', full_name: 'Ops', role: 'admin', is_active: true },
    { id: stranger, email: 'other@customer.test', full_name: 'Other', role: 'patron', is_active: true });
  db.events.push({ id: event, name: 'Stepwell Night', event_date: '2026-12-01', event_time: '19:00', venue: 'Stepwell' });
};

// ---------------------------------------------------------------- 1
print('== 1. browser verification → ticket email');
fresh();
let b = newBooking(1);
let r = await verify(b.id, 'order_1', 'pay_1', customer);
check(r.status === 200 && r.json.success && booking(b).status === 'confirmed' && db.tickets.length === 2, 'verify-payment confirms the booking and issues tickets (server-side)');
check(rowsFor(b).length === 1 && rowsFor(b)[0].status === 'queued' && rowsFor(b)[0].notification_type === 'ticket.confirmed', 'verify-payment queues one ticket email in email_outbox');
r = await ticketEmail(b.id, customer);
check(r.json?.queued === true && mail.length === 0, "the browser's follow-up send-ticket-email call is a no-op (already queued)");
r = await drain();
check(r.status === 200 && mail.length === 1 && mail[0].to === 'asha@customer.test' && mail[0].attachments === 1, 'the drain sends it once, to the account email (not the typed one), with the booking QR');
check(mail[0].html.includes('TS-T1') && mail[0].html.includes('Stepwell Night'), 'the email is the ticket email (event, booking reference)');
check(booking(b).ticket_email_status === 'sent' && rowsFor(b)[0].status === 'sent', 'booking.ticket_email_status = sent; outbox row = sent');
await drain();
await verify(b.id, 'order_1', 'pay_1', customer);
await drain();
check(mail.length === 1 && rowsFor(b).length === 1, 'repeating verify and the drain sends nothing more');

// ---------------------------------------------------------------- 2
print('== 2. webhook-only payment (browser closed) → ticket email');
fresh();
b = newBooking(2);
r = await webhook('payment.captured', 'order_2', 'pay_2');
check(r.status === 200 && booking(b).status === 'confirmed', 'webhook confirms the booking without any browser call');
check(rowsFor(b).length === 1, 'webhook queues the ticket email');
await drain();
check(mail.length === 1 && booking(b).ticket_email_status === 'sent', 'the drain sends it — no browser verification needed');

// ---------------------------------------------------------------- 3
print('== 3. duplicate webhooks → no duplicate email');
fresh();
b = newBooking(3);
await webhook('payment.captured', 'order_3', 'pay_3');
r = await webhook('payment.captured', 'order_3', 'pay_3');
check(r.status === 200 && r.text === 'ok (duplicate)', 'redelivered payment.captured → 200 duplicate');
await webhook('order.paid', 'order_3', 'pay_3');
await verify(b.id, 'order_3', 'pay_3', customer);
check(rowsFor(b).length === 1, 'payment.captured ×2 + order.paid + browser verify → still one queued email');
await drain(); await drain();
check(mail.length === 1, 'exactly one ticket email sent');
db.payment_webhook_events.length = 0; // a delivery recorded under a new id after the email went out
await webhook('payment.captured', 'order_3', 'pay_3');
await drain();
check(mail.length === 1 && rowsFor(b).length === 1, 'a later redelivery after the email was sent queues nothing new');

// ---------------------------------------------------------------- 4
print('== 4. email provider failure → booking stays successful, email retried');
fresh();
b = newBooking(4);
resendFails = true;
r = await webhook('payment.captured', 'order_4', 'pay_4');
check(r.status === 200, 'webhook answers 200 (payment settled; email is queued, not sent inline)');
r = await drain();
check(r.json.failed === 1 && booking(b).status === 'confirmed' && booking(b).payment_status === 'captured' && db.tickets.length === 2,
  'provider down: the booking stays confirmed + captured, tickets intact');
check(booking(b).ticket_email_status === 'failed' && rowsFor(b)[0].status === 'queued' && rowsFor(b)[0].attempts === 1,
  'ticket_email_status = failed (visible to admins); outbox row back in the queue for retry');
resendFails = false;
await drain();
check(mail.length === 1 && booking(b).ticket_email_status === 'sent' && rowsFor(b)[0].status === 'sent', 'next drain run delivers it; status sent');
fresh();
b = newBooking(5);
faults.outboxInsert = 1;
r = await webhook('payment.captured', 'order_5', 'pay_5');
check(r.status === 500 && booking(b).status === 'confirmed' && rowsFor(b).length === 0, 'queueing fails inside the webhook → 500 for a redelivery; the booking stays confirmed');
r = await webhook('payment.captured', 'order_5', 'pay_5');
check(r.status === 200 && rowsFor(b).length === 1, "Razorpay's redelivery queues the email");
await drain();
check(mail.length === 1, 'and it is sent once');
fresh();
b = newBooking(6);
faults.outboxInsert = 1;
r = await verify(b.id, 'order_6', 'pay_6', customer);
check(r.status === 200 && r.json.success, 'queueing fails inside verify-payment → the payment response is still success');

// ---------------------------------------------------------------- 5
print('== 5. admin resend');
fresh();
b = newBooking(7);
await webhook('payment.captured', 'order_7', 'pay_7');
await drain();
r = await ticketEmail(b.id, customer);
check(r.json?.already_sent === true && mail.length === 1, 'customer re-request after delivery → already_sent, nothing sent');
r = await ticketEmail(b.id, admin, true);
check(r.status === 200 && r.json.success && mail.length === 2 && mail[1].to === 'asha@customer.test', 'admin RESEND (force) sends again, to the booking owner');
r = await ticketEmail(b.id, stranger, true);
check(r.status === 403 && mail.length === 2, 'another customer cannot trigger it (403)');
fresh();
b = newBooking(8);
await webhook('payment.captured', 'order_8', 'pay_8');
await ticketEmail(b.id, admin, true);
r = await drain();
check(mail.length === 1 && rowsFor(b)[0].status === 'skipped' && r.json.skipped === 1, 'admin resent before the drain ran → queued row skipped, no duplicate');

// ---------------------------------------------------------------- 6
print('== 6. privacy');
const allLogs = logs.join('\n');
check(!/@customer\.test|typed@elsewhere/.test(allLogs), 'no customer email address in any log line');
check(!allLogs.includes(KEY_SECRET) && !allLogs.includes(WEBHOOK_SECRET) && !allLogs.includes(CRON), 'no secret in any log line');

print(failed ? `${failed} FAILED` : 'ALL TICKET EMAIL CHECKS PASSED');
process.exit(failed ? 1 : 0);
