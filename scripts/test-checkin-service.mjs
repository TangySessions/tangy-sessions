// src/lib/checkinService.js error handling under Node: supabaseClient is a
// stub whose answer is scripted per case. Checks that a real "nothing there"
// stays empty / not_found, that every network, auth, permission and database
// failure is thrown (reads) or returned as the 'error' result (check-in)
// with a staff-safe message, and that nothing internal leaks.
// The page itself (error + Retry states) is checked in a browser against a
// stubbed API; the database functions are unchanged.
// Run: node scripts/test-checkin-service.mjs
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === './supabaseClient')
    return { shortCircuit: true, url: 'data:text/javascript,export const supabase = globalThis.__supabase; export const isSupabaseConfigured = '
      + (context.parentURL.includes('unconfigured') ? 'false' : 'true') + ';' };
  return next(specifier, context);
}`));

let answer;               // what the next request resolves to (or a function that throws)
const calls = [];
const respond = (name, args) => { calls.push({ name, args }); return typeof answer === 'function' ? answer() : answer; };
const builder = (table) => {
  const chain = { select: () => chain, eq: () => chain, or: () => chain, order: () => chain, limit: () => chain,
    then: (ok, ko) => Promise.resolve().then(() => respond(`from:${table}`)).then(ok, ko) };
  return chain;
};
globalThis.__supabase = { rpc: async (name, args) => respond(name, args), from: builder };
const logged = [];
console.error = (...a) => { logged.push(a); };

const { checkinService, CheckinError } = await import('../src/lib/checkinService.js');

let failed = 0;
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const INTERNAL = /my_checkin_events|attendee_tickets|check_in_ticket|event_checkin_stats|get_checkin_history|booking_checkin_history|PGRST|42501|42P01|relation|select |permission denied for|row-level|JWT|stack|TypeError|\bat \w+ \(/i;
const safe = (msg) => typeof msg === 'string' && msg.length > 0 && !INTERNAL.test(msg);

const ERR = {
  network: { data: null, error: { message: 'TypeError: Failed to fetch', details: 'TypeError: Failed to fetch\n    at fetch (x.js:1:1)', hint: '', code: '' }, status: 0 },
  db: { data: null, error: { message: 'relation "public.attendee_tickets" does not exist', code: '42P01', details: null, hint: null }, status: 404 },
  rpcDb: { data: null, error: { message: 'function my_checkin_events() does not exist', code: '42883' }, status: 404 },
  permission: { data: null, error: { message: 'permission denied for function my_checkin_events', code: '42501' }, status: 403 },
  denied: { data: null, error: { message: 'You do not have permission to check in tickets.', code: 'P0001' }, status: 400 },
  auth: { data: null, error: { message: 'JWT expired', code: 'PGRST301' }, status: 401 },
};

console.log('--- events');
answer = { data: [{ id: 'e1', name: 'Night' }], error: null, status: 200 };
let events = await checkinService.getEvents();
check(events.length === 1 && events[0].id === 'e1', '1. events load');
answer = { data: [], error: null, status: 200 };
check((await checkinService.getEvents()).length === 0, '2. no events → empty list (not an error)');
answer = { data: null, error: null, status: 200 };
check(Array.isArray(await checkinService.getEvents()), '2b. null body → empty list');
for (const [k, kind] of [['network', 'network'], ['rpcDb', 'server'], ['permission', 'permission'], ['auth', 'auth']]) {
  answer = ERR[k];
  const e = await rejects(checkinService.getEvents());
  check(e instanceof CheckinError && e.kind === kind && safe(e.message), `3/4. events ${k} error → thrown CheckinError(${kind}), safe message "${e?.message}"`);
}
answer = () => { throw new TypeError('Failed to fetch'); };
let e = await rejects(checkinService.getEvents());
check(e instanceof CheckinError && e.kind === 'network', '3. a thrown fetch error is thrown as network, not swallowed');

console.log('--- search');
calls.length = 0;
check((await checkinService.searchTickets('', 'e1')).length === 0 && calls.length === 0, 'empty query → [] without a request');
answer = { data: [], error: null, status: 200 };
check((await checkinService.searchTickets('nobody', 'e1')).length === 0, '5. no matching ticket → empty result (shown as not found)');
answer = { data: [{ ticket_id: 't1', booking_id: 'b1' }], error: null, status: 200 };
check((await checkinService.searchTickets('asha', 'e1'))[0].ticket_id === 't1', 'search hit returned');
for (const [k, kind] of [['db', 'server'], ['network', 'network'], ['permission', 'permission'], ['auth', 'auth']]) {
  answer = ERR[k];
  e = await rejects(checkinService.searchTickets('asha', 'e1'));
  check(e instanceof CheckinError && e.kind === kind && safe(e.message), `6. search ${k} error → thrown (${kind}), never an empty result`);
}

console.log('--- retry after error');
answer = ERR.network;
check(await rejects(checkinService.getEvents()) instanceof CheckinError, '7. first attempt fails');
calls.length = 0;
answer = { data: [{ id: 'e1' }], error: null, status: 200 };
events = await checkinService.getEvents();
check(events[0].id === 'e1' && calls.length === 1 && calls[0].name === 'my_checkin_events', '7. retry succeeds with one read call, nothing written');

console.log('--- stats / recent / booking arrivals');
answer = { data: { checked_in: 0, remaining: 0, tickets_issued: 0 }, error: null, status: 200 };
check((await checkinService.getStats('e1')).checked_in === 0, 'stats load (zero counts are data)');
answer = { data: [], error: null, status: 200 };
check((await checkinService.getRecentCheckins('e1')).length === 0 && (await checkinService.bookingHistory('b1')).length === 0, 'no arrivals → empty lists');
for (const fn of [() => checkinService.getStats('e1'), () => checkinService.getRecentCheckins('e1'), () => checkinService.bookingHistory('b1')]) {
  answer = ERR.db;
  e = await rejects(fn());
  check(e instanceof CheckinError && safe(e.message), `stats/history DB error thrown, not null/[] (${e?.kind})`);
}

console.log('--- check-in');
answer = { data: { result: 'valid', ticket_number: 'T-1', checked_in_at: '2026-10-04T18:00:00Z' }, error: null, status: 200 };
calls.length = 0;
let r = await checkinService.checkInByToken('TANGY:TICKET:abc', 'e1');
check(r.result === 'valid' && calls[0].name === 'check_in_ticket' && calls[0].args.p_token === 'abc' && calls[0].args.p_event_id === 'e1'
  && calls[0].args.p_method === 'qr' && calls[0].args.p_preview === false, '8. successful check-in: same RPC and arguments, result passed through');
answer = { data: { result: 'not_found' }, error: null, status: 200 };
check((await checkinService.checkInByToken('TANGY:TICKET:nope', 'e1')).result === 'not_found', '5. unknown ticket → not_found (unchanged)');
calls.length = 0;
check((await checkinService.checkInByToken('   ', 'e1')).result === 'not_found' && calls.length === 0, 'blank code → not_found without a request');
for (const [k, kind] of [['network', 'network'], ['denied', 'permission'], ['permission', 'permission'], ['auth', 'auth'], ['db', 'server']]) {
  answer = ERR[k];
  r = await checkInByTokenSafe();
  check(r.result === 'error' && r.errorKind === kind && safe(r.error), `9. check-in ${k} failure → 'error' (${kind}): "${r.error}"`);
}
answer = () => { throw new Error('boom at check_in_ticket (rpc.js:12:3)'); };
r = await checkInByTokenSafe();
check(r.result === 'error' && safe(r.error), '9. a thrown exception is still a safe error result (no crash)');
answer = { data: null, error: null, status: 200 };
r = await checkInByTokenSafe();
check(r.result === 'error' && safe(r.error), '9. an empty RPC answer is an error, not a blank screen');
answer = ERR.network;
await checkInByTokenSafe();
answer = { data: { result: 'already_checked_in' }, error: null, status: 200 };
calls.length = 0;
r = await checkInByTokenSafe();
check(r.result === 'already_checked_in' && calls.length === 1, '7. retrying a check-in after a lost response → already_checked_in from the server (no duplicate, one call)');

console.log('--- 10. nothing internal reaches the UI, but developers get the details');
check(logged.length > 0 && logged.some((a) => String(a[0]).startsWith('[check-in]') && a[1]?.message), 'raw errors are logged to the console for developers');

async function checkInByTokenSafe() { return checkinService.checkInByToken('TANGY:BOOKING:grp', 'e1', { method: 'manual', attendeeIds: ['t1'] }); }

// Not configured: a second module instance whose stub reports false.
const fresh = await import('../src/lib/checkinService.js?unconfigured');
e = await rejects(fresh.checkinService.getEvents());
check(e?.kind === 'not_configured' && safe(e.message), 'not connected → thrown error, not an empty list');
r = await fresh.checkinService.checkInByToken('TANGY:TICKET:abc', 'e1');
check(r.result === 'error' && safe(r.error), 'not connected → check-in error result');

console.log(failed ? `${failed} FAILED` : 'ALL CHECK-IN SERVICE CHECKS PASSED');
process.exit(failed ? 1 : 0);
