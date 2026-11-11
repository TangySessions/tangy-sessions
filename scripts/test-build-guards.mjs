// Production build guards (build-guards.js + vite.config.js), host by host.
// Unit checks on the decision functions, then real `vite build`s whose
// output is inspected: on Vercel production AND on a host that sets nothing
// (Azure Static Web Apps, CI), the team-review login, its shared password,
// the demo admin and the dev role switcher are absent from the bundle, and
// the unconfigured-build escape hatch is refused. Preview / development
// builds keep their intended behaviour. Builds go to a temporary directory.
// Run: node scripts/test-build-guards.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployTarget, assertBackendConfigured, reviewMode, demoAdmin } from '../build-guards.js';

let failed = 0;
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

console.log('--- deployTarget: production unless explicitly not');
check(deployTarget({}, { VERCEL_ENV: 'production' }) === 'production', 'Vercel production → production');
check(deployTarget({}, {}) === 'production', 'no host markers (Azure SWA, CI, laptop) → production');
check(deployTarget({}, { VERCEL_ENV: 'preview' }) === 'preview' && deployTarget({}, { VERCEL_ENV: 'development' }) === 'development', 'Vercel preview / development → as marked');
check(deployTarget({ TANGY_DEPLOY_ENV: 'preview' }, {}) === 'preview', 'TANGY_DEPLOY_ENV=preview on any host → preview');
check(deployTarget({ TANGY_DEPLOY_ENV: 'production' }, { VERCEL_ENV: 'preview' }) === 'production', 'TANGY_DEPLOY_ENV=production wins over a Vercel preview marker');
check(deployTarget({ TANGY_DEPLOY_ENV: 'staging-ish' }, { VERCEL_ENV: 'preview' }) === 'production', 'an unrecognised TANGY_DEPLOY_ENV value → production (fails safe)');

console.log('--- decisions');
const cfg = { VITE_SUPABASE_URL: 'https://abc.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x' };
check(assertBackendConfigured(cfg, 'production') === null, 'configured backend → builds');
check(throws(() => assertBackendConfigured({ TANGY_ALLOW_UNCONFIGURED_BUILD: '1' }, 'production')), 'unconfigured + escape hatch → refused for production (any host)');
check(typeof assertBackendConfigured({ TANGY_ALLOW_UNCONFIGURED_BUILD: '1' }, 'development') === 'string', 'unconfigured + escape hatch → allowed (warning) for development');
check(throws(() => assertBackendConfigured({ VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_PUBLISHABLE_KEY: 'k' }, 'production')), 'local Supabase URL → refused for production');
check(assertBackendConfigured({ VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_PUBLISHABLE_KEY: 'k' }, 'development') === null, 'local Supabase URL → fine for development');
const rv = { VITE_TEAM_REVIEW_MODE: 'true', VITE_TEAM_REVIEW_PASSWORD: 'pw' };
check(!reviewMode(rv, 'production').enabled, 'review mode → off for production');
check(reviewMode({ ...rv, TANGY_ALLOW_REVIEW_BUILD: '1' }, 'production').enabled, 'review mode on production only with the deliberate TANGY_ALLOW_REVIEW_BUILD=1');
check(reviewMode(rv, 'preview').enabled && !reviewMode({ VITE_TEAM_REVIEW_MODE: 'true' }, 'preview').enabled, 'review mode → on for preview when its password is set');
check(!demoAdmin({ VITE_DEMO_ADMIN_ENABLED: 'true', TANGY_ALLOW_DEMO_BUILD: '1' }, 'production').enabled, 'demo admin → never in a production build, even with TANGY_ALLOW_DEMO_BUILD=1');
check(demoAdmin({ VITE_DEMO_ADMIN_ENABLED: 'true', TANGY_ALLOW_DEMO_BUILD: '1' }, 'development').enabled, 'demo admin → deliberate development demo build only');

console.log('--- real builds');
const SENTINEL = 'REVIEW-PASSWORD-SENTINEL-7f3a';
const base = { ...cfg, VITE_TEAM_REVIEW_MODE: 'true', VITE_TEAM_REVIEW_PASSWORD: SENTINEL, VITE_DEMO_ADMIN_ENABLED: 'true' };
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VERCEL_ENV|TANGY_|VITE_)/.test(k)));
const build = (vars) => {
  const out = mkdtempSync(join(tmpdir(), 'tangy-build-'));
  const r = spawnSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], { env: { ...clean, ...vars }, encoding: 'utf8', timeout: 240000 });
  let js = '';
  if (r.status === 0) for (const f of readdirSync(join(out, 'assets'))) if (f.endsWith('.js')) js += readFileSync(join(out, 'assets', f), 'utf8');
  const files = r.status === 0 ? readdirSync(join(out, 'assets')).join(' ') : '';
  rmSync(out, { recursive: true, force: true });
  return { ok: r.status === 0, js, files, log: `${r.stdout}${r.stderr}` };
};
const reviewIn = (b) => b.files.includes('TeamDemoLoginPage') || b.js.includes('/team-demo');
const devIn = (b) => /superadmin@tangy\.local|__dev\/mock-session|DevRoleSelector/.test(b.js);

let b = build({ ...base, VERCEL_ENV: 'production' });
check(b.ok && !reviewIn(b) && !b.js.includes(SENTINEL) && !devIn(b), 'Vercel production: builds; no review login, no review password, no dev tools in the bundle');
b = build({ ...base });
check(b.ok && !reviewIn(b) && !b.js.includes(SENTINEL) && !devIn(b), 'Azure / unmarked host: builds; no review login, no review password, no dev tools (previously the review login shipped here)');
check(/review demo login is compiled out|team-review demo login is compiled out/.test(b.log), '...and the build says why');
b = build({ ...base, VERCEL_ENV: 'preview' });
check(b.ok && reviewIn(b) && !devIn(b), 'Vercel preview: the review login is included as intended; dev tools still compiled out');
b = build({ ...base, TANGY_DEPLOY_ENV: 'preview' });
check(b.ok && reviewIn(b), 'Azure staging built with TANGY_DEPLOY_ENV=preview: review login included as intended');
b = build({ TANGY_ALLOW_UNCONFIGURED_BUILD: '1' });
check(!b.ok && /refused for a production build/.test(b.log), 'unconfigured build on an unmarked host → build fails (escape hatch refused)');
b = build({ TANGY_ALLOW_UNCONFIGURED_BUILD: '1', VERCEL_ENV: 'production' });
check(!b.ok, 'unconfigured build on Vercel production → build fails');
b = build({ TANGY_ALLOW_UNCONFIGURED_BUILD: '1', TANGY_DEPLOY_ENV: 'development' });
check(b.ok && /never deploy it/.test(b.log), 'explicit development smoke build without a backend → builds with a warning');
b = build({ ...cfg, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abc' });
check(!b.ok && /Supabase secret/.test(b.log), 'a secret key in a VITE_ variable → build fails (unchanged)');

console.log(failed ? `${failed} FAILED` : 'ALL BUILD GUARD CHECKS PASSED');
process.exit(failed ? 1 : 0);
