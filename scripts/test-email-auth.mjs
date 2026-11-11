// Who may trigger send-ticket-email and send-approval-email, through the real
// handlers under Node: Deno is shimmed, supabase-js is an in-memory database
// (sessions are tokens "tok-<user id>"; profiles carry role + is_active as in
// the database), and Resend is a stubbed fetch that records sent mail.
// Deactivating an account only sets profiles.is_active = false — the session
// stays valid — so these checks are what stop a deactivated admin/staff.
// Staff may resend only for bookings of events they are assigned to: the
// function asks the database's is_assigned_to_event() under the caller's own
// session; the stub below answers exactly as that SQL does (its behaviour on
// the real schema is checked in supabase/tests/staff_ticket_resend_scope.test.sql).
// Ticket email delivery itself is covered by scripts/test-ticket-email.mjs.
// Run: node scripts/test-email-auth.mjs
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('https://esm.sh/@supabase/supabase-js'))
    return { shortCircuit: true, url: 'data:text/javascript,export const createClient = (...a) => globalThis.__createClient(...a);' };
  if (specifier.startsWith('https://esm.sh/qrcode'))
    return { shortCircuit: true, url: 'data:text/javascript,export default { toDataURL: async (t) => "data:image/png;base64," + btoa(t) };' };
  return next(specifier, context);
}`));

const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon-test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test', RESEND_API_KEY: 're_test', SITE_URL: 'https://tangy.example' };
const handlers = {};
let loading = null;
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handlers[loading] = h; } };

// ---------------------------------------------------------------- database
const db = {};
const reads = [];        // [table, columns] read by the functions with the service client
const rpcCalls = [];     // [client, name, args]
const query = (table, cols) => {
  const filters = [];
  const rows = () => db[table].filter((r) => filters.every(([c, v]) => r[c] === v));
  const q = {
    eq: (c, v) => { filters.push([c, v]); return q; },
    order: () => q,
    single: async () => { const r = rows(); return r.length === 1 ? { data: { ...r[0] }, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }; },
    maybeSingle: async () => { if (db.failProfiles && table === 'profiles') return { data: null, error: { code: '08006', message: 'connection lost' } }; const r = rows(); return { data: r[0] ? { ...r[0] } : null, error: null }; },
    then: (ok, ko) => Promise.resolve({ data: rows().map((r) => ({ ...r })), error: null }).then(ok, ko),
  };
  reads.push([table, cols]);
  return q;
};
// is_assigned_to_event(p_event_id) as in 0017: an active staff/admin/super admin
// with a non-declined 'staff' assignment to that event; auth.uid() is the
// session's user — none for the service client.
const isAssigned = (uid, eventId) => {
  const p = db.profiles.find((x) => x.id === uid && x.is_active === true);
  return !!p && ['staff', 'admin', 'super_admin'].includes(p.role)
    && db.event_assignments.some((a) => a.event_id === eventId && a.assignee_id === uid && a.assignee_role === 'staff' && a.status !== 'declined');
};
globalThis.__createClient = (_url, key, opts) => ({
  rpc: async (name, args) => {
    const token = (opts?.global?.headers?.Authorization || '').replace('Bearer ', '');
    const uid = key === env.SUPABASE_ANON_KEY ? db.profiles.find((x) => `tok-${x.id}` === token)?.id : undefined;
    rpcCalls.push([key === env.SUPABASE_ANON_KEY ? 'caller' : 'service', name, args]);
    if (db.failRpc) return { data: null, error: { code: '08006', message: 'connection lost' } };
    if (name === 'is_assigned_to_event') return { data: uid ? isAssigned(uid, args.p_event_id) : false, error: null };
    return { data: null, error: { code: '42883', message: `unknown rpc ${name}` } };
  },
  auth: {
    getUser: async () => {
      const token = (opts?.global?.headers?.Authorization || '').replace('Bearer ', '');
      // A service-role key is not a user session: getUser() has no user for it.
      const p = db.profiles.find((x) => `tok-${x.id}` === token);
      // The JWT's own metadata claims the caller is an active super admin — never trusted.
      return p ? { data: { user: { id: p.id, email: p.email, user_metadata: { role: 'super_admin', is_active: true }, app_metadata: { role: 'super_admin' } } }, error: null }
        : { data: { user: null }, error: { message: 'invalid JWT' } };
    },
  },
  from: (table) => ({
    select: (cols) => query(table, cols),
    insert: (row) => ({ then: (ok, ko) => { db[table].push({ id: `row-${db[table].length + 1}`, ...row }); return Promise.resolve({ error: null }).then(ok, ko); } }),
    update: (patch) => {
      const filters = [];
      const chain = { eq: (c, v) => { filters.push([c, v]); return chain; },
        then: (ok, ko) => { for (const r of db[table]) if (filters.every(([c, v]) => r[c] === v)) Object.assign(r, patch); return Promise.resolve({ error: null }).then(ok, ko); } };
      return chain;
    },
  }),
});
const mail = [];
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url}`);
  const body = JSON.parse(init.body);
  mail.push({ to: body.to[0], subject: body.subject });
  return new Response('{"id":"em_1"}', { status: 200 });
};
const logs = [];
for (const level of ['log', 'warn', 'error']) console[level] = (...a) => logs.push(a.map(String).join(' '));

for (const name of ['send-ticket-email', 'send-approval-email']) { loading = name; await import(`../supabase/functions/${name}/index.ts`); loading = null; }
const call = async (name, body, token) => {
  const headers = { 'Content-Type': 'application/json', Origin: 'https://tangy.example' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await handlers[name](new Request(`https://fn.example/${name}`, { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json().catch(() => null) };
};

const U = { patron: 'u-patron', other: 'u-other', staff: 'u-staff', admin: 'u-admin', sadmin: 'u-sadmin', artist: 'u-artist', xadmin: 'u-xadmin', xstaff: 'u-xstaff', xsadmin: 'u-xsadmin', ghost: 'u-ghost',
  staffB: 'u-staff-b', staffAB: 'u-staff-ab', staff0: 'u-staff-none', volunteer: 'u-volunteer' };
const reset = () => {
  Object.assign(db, {
    failProfiles: false, failRpc: false,
    profiles: [
      { id: U.patron, email: 'asha@customer.test', full_name: 'Asha', role: 'patron', is_active: true },
      { id: U.other, email: 'other@customer.test', full_name: 'Other', role: 'patron', is_active: true },
      { id: U.staff, email: 'staff@tangy.test', full_name: 'Sam', role: 'staff', is_active: true },
      { id: U.admin, email: 'admin@tangy.test', full_name: 'Ada', role: 'admin', is_active: true },
      { id: U.sadmin, email: 'super@tangy.test', full_name: 'Sue', role: 'super_admin', is_active: true },
      { id: U.artist, email: 'artist@x.test', full_name: 'Ravi', role: 'artist', is_active: true },
      { id: U.xadmin, email: 'gone-admin@tangy.test', full_name: 'Ex Admin', role: 'admin', is_active: false },
      { id: U.xstaff, email: 'gone-staff@tangy.test', full_name: 'Ex Staff', role: 'staff', is_active: false },
      { id: U.xsadmin, email: 'gone-super@tangy.test', full_name: 'Ex Super', role: 'super_admin', is_active: false },
      { id: U.ghost, email: 'ghost@tangy.test', full_name: 'No flag', role: 'admin' },   // is_active missing → not active
      { id: U.staffB, email: 'staff-b@tangy.test', full_name: 'Bea', role: 'staff', is_active: true },
      { id: U.staffAB, email: 'staff-ab@tangy.test', full_name: 'Abe', role: 'staff', is_active: true },
      { id: U.staff0, email: 'staff-0@tangy.test', full_name: 'Nil', role: 'staff', is_active: true },
      { id: U.volunteer, email: 'vol@tangy.test', full_name: 'Val', role: 'volunteer', is_active: true },
    ],
    // U.staff works Event A (ev-1); staffB works Event B (ev-2); staffAB works both;
    // xstaff was assigned to A before being deactivated; the volunteer has a crew slot on A.
    event_assignments: [
      { event_id: 'ev-1', assignee_id: U.staff, assignee_role: 'staff', status: 'assigned' },
      { event_id: 'ev-2', assignee_id: U.staffB, assignee_role: 'staff', status: 'confirmed' },
      { event_id: 'ev-1', assignee_id: U.staffAB, assignee_role: 'staff', status: 'confirmed' },
      { event_id: 'ev-2', assignee_id: U.staffAB, assignee_role: 'staff', status: 'completed' },
      { event_id: 'ev-1', assignee_id: U.xstaff, assignee_role: 'staff', status: 'confirmed' },
      { event_id: 'ev-1', assignee_id: U.volunteer, assignee_role: 'volunteer', status: 'confirmed' },
    ],
    bookings: [
      { id: 'bk-1', user_id: U.patron, event_id: 'ev-1', status: 'confirmed', registration_code: 'TS-AAAA1111', quantity: 1, amount: 1180, attendee_name: 'Asha', ticket_email_status: 'sent' },
      { id: 'bk-2', user_id: U.other, event_id: 'ev-2', status: 'confirmed', registration_code: 'TS-BBBB2222', quantity: 1, amount: 1180, attendee_name: 'Other', ticket_email_status: 'sent' },
      { id: 'bk-3', user_id: U.patron, event_id: 'ev-2', status: 'cancelled', registration_code: 'TS-CCCC3333', quantity: 1, amount: 1180, attendee_name: 'Asha', ticket_email_status: 'sent' },
    ],
    tickets: [{ id: 't-1', booking_id: 'bk-1', ticket_number: 'TS-AAAA1111-01', attendee_name: 'Asha', token: 'tok' },
      { id: 't-2', booking_id: 'bk-2', ticket_number: 'TS-BBBB2222-01', attendee_name: 'Other', token: 'tok2' }],
    events: [{ id: 'ev-1', name: 'Stepwell Night', event_date: '2026-12-01', event_time: '19:00', venue: 'Stepwell' },
      { id: 'ev-2', name: 'Baradari Evening', event_date: '2026-12-08', event_time: '19:00', venue: 'Baradari' }],
    email_outbox: [],
    artists: [{ id: 'ar-1', user_id: U.artist, name: 'Ravi', status: 'approved' }],
    application_notifications: [{ id: 'n-1', source_table: 'artists', source_id: 'ar-1', notification_type: 'approval', status: 'pending' }],
  });
  mail.length = 0; reads.length = 0; rpcCalls.length = 0;
};
let failed = 0;
const check = (cond, label) => { console.info(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; };
const resend = (u, extra = {}) => call('send-ticket-email', { booking_id: 'bk-1', force: true, ...extra }, `tok-${u}`);
const resendB = (u, extra = {}) => call('send-ticket-email', { booking_id: 'bk-2', force: true, ...extra }, `tok-${u}`);
const approve = (u, extra = {}) => call('send-approval-email', { source_table: 'artists', source_id: 'ar-1', force: true, ...extra }, `tok-${u}`);
const LEAK = /is_active|deactivat|inactive|disabled|super_admin|role|staff|profile/i;

console.info('--- send-ticket-email (owner, active admin/super admin, or active staff on the booking\'s event)');
for (const [u, label] of [[U.admin, 'active admin'], [U.staff, 'active staff assigned to the booking\'s event'], [U.sadmin, 'active super admin']]) {
  reset(); const r = await resend(u);
  check(r.status === 200 && r.json?.success === true && mail.length === 1 && mail[0].to === 'asha@customer.test', `1/2. ${label} can resend the ticket email (to the booking's account email)`);
}
reset(); let r = await resend(U.patron);
check(r.status === 200 && r.json?.success === true && mail.length === 1, '11. the booking owner (patron) can still trigger their own ticket email');
for (const [u, label] of [[U.xadmin, 'deactivated admin'], [U.xstaff, 'deactivated staff'], [U.xsadmin, 'deactivated super admin'], [U.ghost, 'admin row without is_active']]) {
  reset(); r = await resend(u);
  check(r.status === 403 && mail.length === 0 && db.bookings[0].ticket_email_status === 'sent', `3/4. ${label} → 403, nothing sent, booking untouched`);
  check(r.json?.error === 'Not authorized for this booking.' && !LEAK.test(JSON.stringify(r.json)), `9. ${label}: same generic message as any non-team caller, no role/account detail`);
}
reset(); r = await resend(U.other);
check(r.status === 403 && r.json?.error === 'Not authorized for this booking.' && mail.length === 0, '7. another customer → 403 (ownership check unchanged)');
reset(); r = await resend(U.artist);
check(r.status === 403 && mail.length === 0, '7. an artist (not team, not owner) → 403');
reset(); r = await call('send-ticket-email', { booking_id: 'bk-1', force: true });
check(r.status === 401 && mail.length === 0, '6. no session → 401');
reset(); r = await call('send-ticket-email', { booking_id: 'bk-1', force: true }, 'garbage-token');
check(r.status === 401 && mail.length === 0, '6. invalid session → 401');
reset(); r = await resend(U.xadmin, { is_active: true, role: 'super_admin', user: { is_active: true }, profile: { role: 'admin', is_active: true } });
check(r.status === 403 && mail.length === 0, '8. deactivated admin sending is_active/role in the body → still 403');
check(reads.some(([t, c]) => t === 'profiles' && /is_active/.test(c || '')), 'is_active is read from profiles by the function (JWT metadata claiming super_admin is ignored)');

console.info('--- staff are scoped to the events they are assigned to');
reset(); r = await resendB(U.staff);
check(r.status === 403 && r.json?.error === 'Not authorized for this booking.' && mail.length === 0 && db.bookings[1].ticket_email_status === 'sent',
  '4. staff assigned to Event A → booking of Event B: 403, nothing sent, booking untouched');
reset(); r = await resendB(U.staffB);
check(r.status === 200 && mail.length === 1 && mail[0].to === 'other@customer.test', '3. staff assigned to Event B → booking of Event B: sent to that booking\'s account email');
reset(); r = await resend(U.staffB);
check(r.status === 403 && mail.length === 0, '4. staff assigned to Event B → booking of Event A: 403');
reset(); r = await resend(U.staffAB); const r2 = await resendB(U.staffAB);
check(r.status === 200 && r2.status === 200 && mail.length === 2, 'multiple assignments: staff on A and B (completed) can resend for both');
reset(); r = await resend(U.staff0); const r3 = await resendB(U.staff0);
check(r.status === 403 && r3.status === 403 && mail.length === 0, '5. active staff with no assignment → 403 for every booking');
reset(); r = await resend(U.volunteer);
check(r.status === 403 && mail.length === 0 && !rpcCalls.length, 'a volunteer with a crew slot on the event → 403 (not team; no change)');
reset(); r = await resendB(U.staff, { event_id: 'ev-1', eventId: 'ev-1', booking: { event_id: 'ev-1' } });
check(r.status === 403 && mail.length === 0, '10. staff on A sends a B booking with event_id: ev-1 in the body → still 403 (event comes from the booking row)');
check(rpcCalls.length === 1 && rpcCalls[0][0] === 'caller' && rpcCalls[0][1] === 'is_assigned_to_event' && rpcCalls[0][2].p_event_id === 'ev-2',
  'the assignment check runs under the caller\'s session, for the booking\'s own event (ev-2)');
reset(); r = await resendB(U.staff, { role: 'admin', is_active: true, permissions: ['bookings.manage'], assigned: true });
check(r.status === 403 && mail.length === 0, '11. spoofed role / permissions / assigned flag in the body → still 403 (and the JWT\'s own super_admin claim is ignored)');
reset(); r = await call('send-ticket-email', { booking_id: 'bk-3', force: true }, `tok-${U.staff}`);
check(r.status === 403, 'a cancelled booking of Event B: staff on A → 403 (authorization before the booking state)');
reset(); r = await call('send-ticket-email', { booking_id: 'bk-3', force: true }, `tok-${U.staffB}`);
check(r.status === 409 && mail.length === 0, 'the same cancelled booking: staff on B are authorized, then refused as not confirmed (409), as an admin would be');
reset(); r = await call('send-ticket-email', { booking_id: 'bk-3', force: true }, `tok-${U.admin}`);
check(r.status === 409 && mail.length === 0, '13. admin on the cancelled booking → 409 as before');
reset(); r = await resendB(U.admin); const r4 = await resendB(U.sadmin);
check(r.status === 200 && r4.status === 200 && mail.length === 2 && !rpcCalls.length, '13. admin / super admin stay global (any event, no assignment needed or checked)');
reset(); r = await resendB(U.other);
check(r.status === 200 && mail.length === 1 && !rpcCalls.length, '8. the owner of the Event B booking can still trigger their own email (no assignment check)');

console.info('--- assignment changes take effect on the next request');
reset(); r = await resendB(U.staff);
check(r.status === 403, 'staff on A only: Event B refused');
db.event_assignments.push({ event_id: 'ev-2', assignee_id: U.staff, assignee_role: 'staff', status: 'assigned' });
r = await resendB(U.staff);
check(r.status === 200 && mail.length === 1, 'assigned to B → works on the next request');
db.event_assignments = db.event_assignments.filter((a) => !(a.event_id === 'ev-2' && a.assignee_id === U.staff));
r = await resendB(U.staff);
check(r.status === 403 && mail.length === 1, 'assignment removed → stops on the next request');
db.event_assignments.find((a) => a.event_id === 'ev-1' && a.assignee_id === U.staff).status = 'declined';
r = await resend(U.staff);
check(r.status === 403 && mail.length === 1, 'assignment declined → no access to Event A either');
reset(); db.failRpc = true; r = await resend(U.staff);
check(r.status === 403 && mail.length === 0, 'assignment check fails → fails closed (403)');

console.info('--- deactivation takes effect on the very next request');
reset(); r = await resend(U.admin);
check(r.status === 200 && mail.length === 1, 'admin resends while active');
db.profiles.find((p) => p.id === U.admin).is_active = false;   // admin_set_user_active(..., false) — same session
r = await resend(U.admin);
check(r.status === 403 && mail.length === 1, 'deactivated a moment later, same session → 403 (no caching)');
db.profiles.find((p) => p.id === U.admin).is_active = true;
r = await resend(U.admin);
check(r.status === 200 && mail.length === 2, 'reactivated → works again');
reset(); db.failProfiles = true; r = await resend(U.admin);
check(r.status === 403 && mail.length === 0, 'profile lookup fails → fails closed (403, nothing sent)');

console.info('--- send-approval-email (active admin / super admin only, as before)');
for (const [u, label] of [[U.admin, 'active admin'], [U.sadmin, 'active super admin']]) {
  reset(); r = await approve(u);
  check(r.status === 200 && r.json?.success === true && mail.length === 1 && mail[0].to === 'artist@x.test' && db.application_notifications[0].status === 'sent',
    `2. ${label} sends the approval email to the applicant's account email`);
}
reset(); r = await approve(U.staff);
check(r.status === 403 && mail.length === 0, '7. active staff, even assigned → 403 (approval email stays admin-only, unchanged)');
for (const [u, label] of [[U.xadmin, 'deactivated admin'], [U.xsadmin, 'deactivated super admin'], [U.xstaff, 'deactivated staff'], [U.ghost, 'admin row without is_active']]) {
  reset(); r = await approve(u);
  check(r.status === 403 && mail.length === 0 && db.application_notifications[0].status === 'pending', `5. ${label} → 403, nothing sent, notification untouched`);
  check(r.json?.error === 'Admin access required.' && !/is_active|deactivat|inactive|disabled|super_admin|profile/i.test(JSON.stringify(r.json)), `9. ${label}: same message as any non-admin`);
}
reset(); r = await approve(U.patron);
check(r.status === 403 && mail.length === 0, '7. a customer → 403');
reset(); r = await call('send-approval-email', { source_table: 'artists', source_id: 'ar-1' });
check(r.status === 401 && mail.length === 0, '6. no session → 401');
reset(); r = await approve(U.xadmin, { is_active: true, role: 'admin' });
check(r.status === 403 && mail.length === 0, '8. spoofed is_active/role in the body → still 403');
reset(); r = await approve(U.admin, { force: false });
check(r.status === 200 && mail.length === 1, '11. first send without force works');
r = await approve(U.admin, { force: false });
check(r.status === 200 && r.json?.already_sent === true && mail.length === 1, '11/12. second call is idempotent (already_sent, no second email)');
reset(); db.profiles.find((p) => p.id === U.admin).is_active = false; r = await approve(U.admin);
check(r.status === 403 && mail.length === 0, 'deactivated just before the request → 403');

console.info('--- 10. service role / internal');
reset(); r = await call('send-ticket-email', { booking_id: 'bk-1', force: true }, 'service-role-test');
check(r.status === 401 && mail.length === 0, 'a service-role key is not a user session → 401, as before (no internal caller uses these functions)');
reset(); r = await call('send-approval-email', { source_table: 'artists', source_id: 'ar-1' }, 'service-role-test');
check(r.status === 401 && mail.length === 0, 'same for send-approval-email');

console.info('--- 12. no outbox side effects');
check(db.email_outbox.length === 0, 'these functions never touched email_outbox in any case above (queueing stays with the payment functions)');
check(!logs.some((l) => /asha@customer\.test|artist@x\.test|re_test|service-role-test/.test(l)), 'no email address or secret in any log line');

console.info(failed ? `${failed} FAILED` : 'ALL EMAIL AUTHORIZATION CHECKS PASSED');
process.exit(failed ? 1 : 0);
