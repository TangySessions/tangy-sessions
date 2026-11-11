// Runs the real Edge Function handlers under Node (no Deno, no network):
// Deno.serve / Deno.env are shimmed, and the esm.sh imports (supabase-js,
// qrcode) are swapped for in-process stubs, so each request goes through the
// function's own code. Covers the CORS answer of every browser-called
// function and the HTTP status of every razorpay-webhook path.
// Run: node scripts/test-edge-functions.mjs
import { register } from 'node:module';
import { createHmac } from 'node:crypto';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('https://esm.sh/@supabase/supabase-js'))
    return { shortCircuit: true, url: 'data:text/javascript,export const createClient = (...a) => globalThis.__createClient(...a);' };
  if (specifier.startsWith('https://esm.sh/qrcode'))
    return { shortCircuit: true, url: 'data:text/javascript,export default { toDataURL: async () => "data:image/png;base64,AA==" };' };
  return next(specifier, context);
}`));

let env = {};
const handlers = {};
let loading = null;
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handlers[loading] = h; } };
const load = async (name) => { loading = name; await import(`../supabase/functions/${name}/index.ts`); loading = null; return handlers[name]; };

let failed = 0;
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; };
const acao = (res) => res.headers.get('Access-Control-Allow-Origin');
const quiet = async (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };

// ---------------------------------------------------------------------------
// Supabase client stub. Browser functions: auth.getUser() answers "no session"
// (the function then returns 401 through its JSON helper, which carries CORS).
// Webhook: every call the function makes is scripted per test via `db`.
let db;
const calls = [];
const thenable = (result) => ({ then: (ok, ko) => Promise.resolve(typeof result === 'function' ? result() : result).then(ok, ko) });
globalThis.__createClient = () => ({
  auth: { getUser: async () => ({ data: { user: null }, error: { message: 'no session' } }) },
  rpc: async (name) => {
    calls.push(`rpc:${name}`);
    const r = db.rpc?.[name];
    if (r instanceof Error) throw r;
    return r ?? { data: null, error: null };
  },
  from: (table) => ({
    insert: () => { calls.push(`insert:${table}`); return thenable(db.insert ?? { error: null }); },
    select: () => {
      const chain = { eq: () => chain, maybeSingle: async () => { calls.push(`read:${table}`); return db.existing ?? { data: null, error: null }; } };
      return chain;
    },
    update: () => {
      const key = table === 'payment_webhook_events' ? 'mark' : `update:${table}`;
      const chain = { eq: () => chain, in: () => chain, lt: () => chain, then: (ok, ko) => { calls.push(key); return Promise.resolve(db[key] ?? { error: null }).then(ok, ko); } };
      return chain;
    },
  }),
});

// ---------------------------------------------------------------------------
console.log('== CORS: _shared/cors.ts');
const cors = await import('../supabase/functions/_shared/cors.ts');
const optionsReq = (origin) => new Request('https://fn.example/x', { method: 'OPTIONS', headers: origin ? { Origin: origin } : {} });
const allow = (origin) => cors.corsFor(optionsReq(origin))['Access-Control-Allow-Origin'];

env = { SITE_URL: 'https://www.tangysessions.com/' };
check(allow('https://www.tangysessions.com') === 'https://www.tangysessions.com', 'canonical SITE_URL origin is echoed (trailing slash ignored)');
check(allow('https://tangysessions.com') === undefined, 'another origin gets no Access-Control-Allow-Origin');
check(allow('https://evil.example') === undefined, 'a disallowed origin gets no Access-Control-Allow-Origin');
check(allow(null) === undefined, 'no Origin header → no Access-Control-Allow-Origin');
check(allow('null') === undefined, 'the "null" origin is refused');
check(allow('https://www.tangysessions.com.evil.example') === undefined, 'a look-alike origin is refused (exact match only)');
env = { SITE_URL: 'https://WWW.TangySessions.com/some/path' };
check(allow('https://www.tangysessions.com') === 'https://www.tangysessions.com', 'SITE_URL is reduced to its origin (case, path)');
env = { ALLOWED_ORIGINS: 'https://tangysessions.com, https://www.tangysessions.com', SITE_URL: 'https://x.example' };
check(allow('https://tangysessions.com') === 'https://tangysessions.com', 'first ALLOWED_ORIGINS entry is echoed');
check(allow('https://www.tangysessions.com') === 'https://www.tangysessions.com', 'second ALLOWED_ORIGINS entry is echoed (was: first origin)');
check(allow('https://x.example') === undefined, 'ALLOWED_ORIGINS wins over SITE_URL');
check(cors.corsFor(optionsReq('https://evil.example')).Vary === 'Origin', 'Vary: Origin is always set');
env = {};
check(allow('http://127.0.0.1:5173') === 'http://127.0.0.1:5173' && allow('http://localhost:5173') === 'http://localhost:5173', 'nothing configured (local dev): loopback origins are echoed');
check(allow('https://evil.example') === undefined && allow('http://192.168.1.5:5173') === undefined, 'nothing configured: any other origin is refused (never "*")');

env = { ALLOWED_ORIGINS: 'https://tangysessions.com,https://www.tangysessions.com' };
const pre = cors.handleOptions(optionsReq('https://www.tangysessions.com'));
check(pre?.status === 200 && acao(pre) === 'https://www.tangysessions.com'
  && /authorization/.test(pre.headers.get('Access-Control-Allow-Headers')) && pre.headers.get('Access-Control-Allow-Methods') === 'POST, OPTIONS',
  'OPTIONS preflight: 200, allowed origin echoed, headers and methods listed');
const preBad = cors.handleOptions(optionsReq('https://evil.example'));
check(preBad?.status === 200 && acao(preBad) === null, 'OPTIONS preflight from a disallowed origin: no Access-Control-Allow-Origin');
check(cors.handleOptions(new Request('https://fn.example/x', { method: 'POST' })) === null, 'non-OPTIONS requests are not short-circuited');

console.log('== CORS: through each browser-called function');
const browserFns = ['razorpay-create-order', 'razorpay-verify-payment', 'send-ticket-email', 'send-approval-email', 'admin-invite-user'];
for (const name of browserFns) {
  const h = await load(name);
  env = { ALLOWED_ORIGINS: 'https://tangysessions.com,https://www.tangysessions.com', SITE_URL: 'https://tangysessions.com' };
  const post = (origin) => quiet(() => h(new Request(`https://fn.example/${name}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })));
  const opt = (origin) => h(new Request(`https://fn.example/${name}`, { method: 'OPTIONS', headers: { Origin: origin } }));
  const r1 = await post('https://tangysessions.com');
  const r2 = await post('https://www.tangysessions.com');
  const r3 = await post('https://evil.example');
  const o2 = await opt('https://www.tangysessions.com');
  const o3 = await opt('https://evil.example');
  check(r1.status === 401 && acao(r1) === 'https://tangysessions.com', `${name}: canonical origin → response carries it (401, no session)`);
  check(acao(r2) === 'https://www.tangysessions.com', `${name}: allowed second origin → response carries the second origin`);
  check(acao(r3) === null, `${name}: disallowed origin → no Access-Control-Allow-Origin`);
  check(o2.status === 200 && acao(o2) === 'https://www.tangysessions.com' && acao(o3) === null, `${name}: OPTIONS → allowed origin echoed, disallowed refused`);
  env = {};
  const r4 = await post('https://evil.example');
  check(acao(r4) === null, `${name}: nothing configured → never "*"`);
}

// ---------------------------------------------------------------------------
console.log('== razorpay-webhook');
const SECRET = 'whsec_test_local_0123456789';
const webhook = await load('razorpay-webhook');
const sign = (body, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex');
const captured = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_T1', order_id: 'order_T1', amount: 59000 } } } });
const send = async ({ body = captured, signature, method = 'POST' } = {}) => {
  calls.length = 0;
  const res = await quiet(() => webhook(new Request('https://fn.example/razorpay-webhook', {
    method, headers: method === 'POST' ? { 'X-Razorpay-Signature': signature ?? sign(body) } : {}, body: method === 'POST' ? body : undefined,
  })));
  return { status: res.status, text: await res.text(), calls: [...calls] };
};
const ok = (r) => r.status === 200;
const noLeak = (r) => !r.text.includes(SECRET) && !/order_T1|pay_T1|connection|relation|permission/i.test(r.text);
env = { RAZORPAY_WEBHOOK_SECRET: SECRET, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test' };
let r;

db = { rpc: { settle_payment: { data: { result: 'confirmed' }, error: null } } };
r = await send();
check(ok(r) && r.calls.join() === 'insert:payment_webhook_events,rpc:settle_payment,mark', 'valid payment.captured → recorded, settled, marked processed, 200');

db = { insert: { error: { code: '23505' } }, existing: { data: { processed: true }, error: null } };
r = await send();
check(ok(r) && r.text === 'ok (duplicate)' && !r.calls.includes('rpc:settle_payment'), 'duplicate of a processed event → 200 "ok (duplicate)", nothing re-run');

db = { insert: { error: { code: '23505' } }, existing: { data: { processed: false }, error: null }, rpc: { settle_payment: { data: { result: 'already_confirmed' }, error: null } } };
r = await send();
check(ok(r) && r.calls.includes('rpc:settle_payment') && r.calls.includes('mark'), 'redelivery of a recorded-but-unprocessed event → processed now (idempotent), 200');

db = {};
r = await send({ signature: sign(captured, 'some_other_secret_value') });
check(r.status === 400 && r.text === 'Invalid signature' && r.calls.length === 0, 'invalid signature → 400, no database call');
r = await send({ signature: '' });
check(r.status === 400 && r.calls.length === 0, 'missing signature → 400');

env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test' };
r = await send();
check(r.status === 503 && r.calls.length === 0, 'RAZORPAY_WEBHOOK_SECRET not set → 503 (unchanged)');
env = { RAZORPAY_WEBHOOK_SECRET: SECRET, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test' };

db = { insert: { error: { code: '08006', message: 'connection failure to relation payment_webhook_events' } } };
r = await send();
check(r.status === 500 && !r.calls.includes('rpc:settle_payment') && noLeak(r), 'event-recording failure → 500 (Razorpay retries), nothing processed, no detail in the response');

db = { insert: { error: { code: '23505' } }, existing: { data: null, error: { message: 'permission denied' } } };
r = await send();
check(r.status === 500 && !r.calls.includes('rpc:settle_payment') && noLeak(r), 'duplicate whose state cannot be read → 500');

db = { rpc: { settle_payment: new Error('fetch failed: socket hang up') } };
r = await send();
check(r.status === 500 && noLeak(r), 'unexpected processing failure (exception) → 500, no detail in the response');

db = { rpc: { settle_payment: { data: null, error: { message: 'could not obtain lock on relation bookings' } } } };
r = await send();
check(r.status === 500 && r.calls.includes('rpc:record_webhook_failure') && noLeak(r), 'settlement database error → failure recorded + alert, 500 so Razorpay retries');

db = { rpc: { settle_payment: { data: { result: 'not_found' }, error: null } } };
r = await send();
check(ok(r) && r.calls.includes('rpc:record_webhook_failure') && !r.calls.includes('mark'), 'no booking for the order (permanent) → failure recorded + alert, 200 (unchanged)');

db = { rpc: { settle_payment: { data: { result: 'not_found' }, error: null }, record_webhook_failure: { error: { message: 'x' } } } };
r = await send();
check(r.status === 500, 'failure that cannot even be recorded → 500');

db = { rpc: { settle_payment: { data: { result: 'confirmed' }, error: null } }, mark: { error: { message: 'x' } } };
r = await send();
check(r.status === 500 && r.calls.includes('rpc:settle_payment'), 'processed but not marked processed → 500 (redelivery re-runs idempotently and marks it)');

db = { rpc: { settle_payment: { data: { result: 'needs_review' }, error: null } } };
r = await send();
check(ok(r) && r.calls.includes('mark') && !r.calls.includes('rpc:record_webhook_failure'), 'payment held for finance review by settle_payment → 200 (settlement decision unchanged)');

const failedBody = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_F1', order_id: 'order_F1' } } } });
db = {};
r = await send({ body: failedBody });
check(ok(r) && r.calls.join() === 'insert:payment_webhook_events,update:bookings,mark', 'payment.failed → the attempt is recorded on the pending hold (seats kept for a retry), 200');
db = { 'update:bookings': { error: { message: 'x' } } };
r = await send({ body: failedBody });
check(r.status === 500 && r.calls.includes('rpc:record_webhook_failure'), 'payment.failed whose update fails → recorded, 500');

db = {};
r = await send({ body: '{"event":', signature: sign('{"event":') });
check(r.status === 400 && r.calls.length === 0, 'validly signed but malformed JSON → 400 (was: 200)');
r = await send({ body: JSON.stringify({ event: 'order.notification' }) });
check(ok(r) && r.calls.length === 0, 'event without a payment id → 200, skipped (unchanged)');
r = await send({ method: 'GET' });
check(r.status === 405, 'GET → 405 (unchanged)');

// ---------------------------------------------------------------------------
console.log('== static');
const { readFileSync, readdirSync } = await import('node:fs');
const sources = readdirSync('supabase/functions').filter((d) => d !== '_shared')
  .map((d) => [d, readFileSync(`supabase/functions/${d}/index.ts`, 'utf8')]);
check(sources.every(([, s]) => !s.includes('corsHeaders')), 'no function uses the old fixed-origin corsHeaders');
check(!readFileSync('supabase/functions/_shared/cors.ts', 'utf8').match(/['"]\*['"]/), "cors.ts never answers '*'");
const wh = readFileSync('supabase/functions/razorpay-webhook/index.ts', 'utf8');
check(/timingSafeEqual\(expectedSignature, signatureHeader\)/.test(wh) && /hmacSha256Hex\(webhookSecret, rawBody\)/.test(wh), 'webhook still verifies the raw body with HMAC-SHA256 and a constant-time compare');

console.log(failed ? `${failed} FAILED` : 'ALL EDGE FUNCTION CHECKS PASSED');
process.exit(failed ? 1 : 0);
