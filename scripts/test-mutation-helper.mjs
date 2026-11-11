// src/lib/mutation.js under Node (supabaseClient stubbed): an update is a
// success only when a row actually changed; RLS-filtered (zero rows), errors
// and network failures are reported in safe words, never as success.
// The dashboards and enquiry screens using it are checked in a browser.
// Run: node scripts/test-mutation-helper.mjs
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if (/\\/lib\\/supabaseClient$/.test(specifier))
    return { shortCircuit: true, url: 'data:text/javascript,export const supabase = null; export const isSupabaseConfigured = true;' };
  if (specifier.startsWith('.') && !/\\.[cm]?jsx?$/.test(specifier) && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier + '.js', context.parentURL);
    if (existsSync(fileURLToPath(url))) return { shortCircuit: true, url: url.href };
  }
  return next(specifier, context);
}
// Vite's import.meta.env does not exist under Node.
export async function load(url, context, next) {
  const r = await next(url, context);
  if (url.includes('/src/') && r.source) return { ...r, source: String(r.source).replaceAll('import.meta.env', '({ DEV: false })') };
  return r;
}`));
const logs = [];
console.error = (...a) => logs.push(a.map(String).join(' '));
const { changeRows, NOT_CHANGED, loadFailed } = await import('../src/lib/mutation.js');

let failed = 0;
const check = (cond, label) => { process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${label}\n`); if (!cond) failed++; };
const q = (result) => ({ select: (cols) => { q.cols = cols; return typeof result === 'function' ? result() : Promise.resolve(result); } });
const RAW = /permission denied for|row-level|relation|42501|PGRST|event_assignments|stack/i;

let r = await changeRows(q({ data: [{ id: 'a' }], error: null }));
check(r.ok && r.rows.length === 1 && q.cols === 'id', 'a row changed → ok (and the update returns ids so zero rows can be detected)');
r = await changeRows(q({ data: [], error: null }));
check(!r.ok && r.message === NOT_CHANGED, 'zero rows (RLS filtered it out / already changed) → NOT a success');
r = await changeRows(q({ data: null, error: { code: 'P0001', message: 'You can only confirm or decline a pending assignment.' } }));
check(!r.ok && r.message === 'You can only confirm or decline a pending assignment.', 'a guard message written for people is shown as is');
r = await changeRows(q({ data: null, error: { code: '42501', message: 'permission denied for table event_assignments' } }));
check(!r.ok && !RAW.test(r.message) && /permission/i.test(r.message), 'a permission error → a safe permission message, no table name');
r = await changeRows(q({ data: null, error: { code: '42P01', message: 'relation "x" does not exist' } }));
check(!r.ok && !RAW.test(r.message), 'an internal database error → a generic safe message');
r = await changeRows(q(() => Promise.reject(new TypeError('Failed to fetch'))));
check(!r.ok && /network/i.test(r.message), 'a thrown network error → "Network error", not success');
check(logs.length >= 3 && logs.every((l) => l.startsWith('[tangy]')), 'raw errors are logged for developers');
check(loadFailed(null) === null && !RAW.test(loadFailed({ code: '42501', message: 'permission denied for table x' })), 'loadFailed: null when fine, safe text when not');

process.stdout.write(failed ? `${failed} FAILED\n` : 'ALL MUTATION HELPER CHECKS PASSED\n');
process.exit(failed ? 1 : 0);
