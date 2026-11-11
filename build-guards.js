// Build-time guards (used by vite.config.js; unit-tested by
// scripts/test-build-guards.mjs). Host-independent: a build counts as
// PRODUCTION unless it explicitly says otherwise, so a host we don't
// recognise (Azure Static Web Apps, a CI runner, a laptop) gets the safe
// behaviour by default.
//
//   TANGY_DEPLOY_ENV = production | preview | development   (any host; wins)
//   VERCEL_ENV       = preview | development                  (Vercel's own marker)
//   anything else → production (including an unknown TANGY_DEPLOY_ENV value)

import process from 'node:process';

const TARGETS = ['production', 'preview', 'development'];

export function deployTarget(env = {}, procEnv = process.env) {
  const explicit = String(env.TANGY_DEPLOY_ENV ?? procEnv.TANGY_DEPLOY_ENV ?? '').trim().toLowerCase();
  if (explicit) return TARGETS.includes(explicit) ? explicit : 'production';
  const vercel = String(procEnv.VERCEL_ENV ?? env.VERCEL_ENV ?? '').trim().toLowerCase();
  if (vercel === 'preview' || vercel === 'development') return vercel;
  return 'production';
}

// A bundle without the Supabase URL and public key can't sign anyone in,
// book, or submit a form, so a build without them fails instead of shipping
// a site that only looks alive. TANGY_ALLOW_UNCONFIGURED_BUILD=1 allows a
// smoke build without a backend — never for production.
// Returns a warning string when the escape hatch was used; throws otherwise.
export function assertBackendConfigured(env, target) {
  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY;
  const production = target === 'production';
  let problem = null;
  if (!url || !key) {
    problem = 'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_ANON_KEY) must be set for a build';
  } else {
    let parsed = null;
    try { parsed = new URL(url); } catch { /* reported below */ }
    const local = parsed && ['localhost', '127.0.0.1'].includes(parsed.hostname);
    if (!parsed || !['https:', 'http:'].includes(parsed.protocol)) problem = `VITE_SUPABASE_URL is not a valid URL: ${url}`;
    else if (parsed.protocol === 'http:' && !local) problem = 'VITE_SUPABASE_URL must use https (http is allowed only for a local Supabase stack)';
    else if (production && local) problem = 'VITE_SUPABASE_URL points at a local Supabase stack in a production build (set TANGY_DEPLOY_ENV=development for a local build)';
  }
  if (!problem) return null;
  if (env.TANGY_ALLOW_UNCONFIGURED_BUILD === '1' && !production) {
    return `${problem} — building anyway (TANGY_ALLOW_UNCONFIGURED_BUILD=1). This bundle has no working backend: never deploy it.`;
  }
  throw new Error(`[tangy] ${problem}${env.TANGY_ALLOW_UNCONFIGURED_BUILD === '1' ? ' (TANGY_ALLOW_UNCONFIGURED_BUILD is refused for a production build)' : ''}. See .env.example.`);
}

// TEAM REVIEW MODE (temporary review deployments only): a one-click demo
// login with a shared password compiled into the bundle. Off unless
// VITE_TEAM_REVIEW_MODE=true and VITE_TEAM_REVIEW_PASSWORD is set; refused
// for a production build unless TANGY_ALLOW_REVIEW_BUILD=1 is set on purpose
// (a temporary review project). Returns { enabled, warning }.
export function reviewMode(env, target, command = 'build') {
  if (env.VITE_TEAM_REVIEW_MODE !== 'true') return { enabled: false, warning: null };
  if (command !== 'build') return { enabled: true, warning: null };
  if (target === 'production' && env.TANGY_ALLOW_REVIEW_BUILD !== '1') {
    return { enabled: false, warning: 'VITE_TEAM_REVIEW_MODE=true ignored for a production build: the team-review demo login is compiled out. Build the review deployment with TANGY_DEPLOY_ENV=preview (or as a Vercel Preview), or set TANGY_ALLOW_REVIEW_BUILD=1 deliberately for a temporary review project.' };
  }
  if (!env.VITE_TEAM_REVIEW_PASSWORD) {
    return { enabled: false, warning: 'VITE_TEAM_REVIEW_MODE=true ignored: VITE_TEAM_REVIEW_PASSWORD (the review demo accounts\' password) is not set.' };
  }
  return { enabled: true, warning: null };
}

// The demo admin entry (VITE_DEMO_ADMIN_ENABLED) is compiled out of every
// build unless TANGY_ALLOW_DEMO_BUILD=1 — and never into a production build.
export function demoAdmin(env, target, command = 'build') {
  if (env.VITE_DEMO_ADMIN_ENABLED !== 'true') return { enabled: false, warning: null };
  if (command === 'serve') return { enabled: true, warning: null };
  if (env.TANGY_ALLOW_DEMO_BUILD === '1' && target !== 'production') return { enabled: true, warning: null };
  return { enabled: false, warning: 'VITE_DEMO_ADMIN_ENABLED=true ignored: the demo admin is compiled out of this build. Unset it, or set TANGY_ALLOW_DEMO_BUILD=1 with TANGY_DEPLOY_ENV=development for a deliberate local demo build.' };
}
