// Static checks on the HTTP security headers shipped for both hosts:
// vercel.json (Vercel) and public/staticwebapp.config.json (Azure Static Web
// Apps, copied into dist/ by the build). Both must send the same headers,
// and the Content-Security-Policy must allow exactly what the app uses
// (Supabase API + realtime, Razorpay Checkout, Google Fonts, the YouTube /
// Vimeo previews on artist applications) and forbid framing, plugins and
// inline/eval script. A browser run against the built site is the second
// check (see docs/OPERATIONS.md, "Security headers").
// Run: node scripts/test-security-headers.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';

let failed = 0;
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; };

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
const swa = JSON.parse(readFileSync('public/staticwebapp.config.json', 'utf8'));
const vercelHeaders = Object.fromEntries((vercel.headers?.find((h) => h.source === '/(.*)')?.headers || []).map((h) => [h.key, h.value]));
const swaHeaders = swa.globalHeaders || {};

check(vercel.rewrites?.some((r) => r.source === '/(.*)' && r.destination === '/index.html'), 'Vercel: SPA rewrite kept');
check(swa.navigationFallback?.rewrite === '/index.html' && swa.navigationFallback.exclude?.includes('/assets/*'), 'Azure SWA: SPA fallback to index.html, static assets excluded');
check(JSON.stringify(Object.entries(vercelHeaders).sort()) === JSON.stringify(Object.entries(swaHeaders).sort()), 'Vercel and Azure send exactly the same headers');

for (const [name, headers] of [['Vercel', vercelHeaders], ['Azure', swaHeaders]]) {
  check(headers['X-Frame-Options'] === 'DENY', `${name}: X-Frame-Options DENY`);
  check(headers['X-Content-Type-Options'] === 'nosniff', `${name}: X-Content-Type-Options nosniff`);
  check(headers['Referrer-Policy'] === 'strict-origin-when-cross-origin', `${name}: Referrer-Policy strict-origin-when-cross-origin`);
  check(/max-age=\d{8,}/.test(headers['Strict-Transport-Security'] || ''), `${name}: HSTS with a long max-age`);
  check(/camera=\(self\)/.test(headers['Permissions-Policy'] || '') && /microphone=\(\)/.test(headers['Permissions-Policy']) && /geolocation=\(\)/.test(headers['Permissions-Policy']),
    `${name}: Permissions-Policy — camera for the QR scanner only on this site, no microphone/geolocation`);
}

const csp = Object.fromEntries((vercelHeaders['Content-Security-Policy'] || '').split(';').map((d) => d.trim()).filter(Boolean)
  .map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));
const has = (dir, src) => (csp[dir] || []).includes(src);
check(has('default-src', "'self'"), "CSP default-src 'self'");
check(has('frame-ancestors', "'none'"), "CSP frame-ancestors 'none' (no clickjacking)");
check(has('object-src', "'none'") && has('base-uri', "'self'") && has('form-action', "'self'"), "CSP object-src 'none', base-uri/form-action 'self'");
check(!(csp['script-src'] || []).some((s) => /unsafe-(inline|eval)|^\*$|^https:$|^data:$/.test(s)), 'CSP script-src: no unsafe-inline/eval, no wildcards');
check(has('script-src', "'self'") && has('script-src', 'https://checkout.razorpay.com'), 'CSP script-src: self + Razorpay Checkout');
check(has('connect-src', 'https://*.supabase.co') && has('connect-src', 'wss://*.supabase.co') && has('connect-src', 'https://*.razorpay.com'), 'CSP connect-src: Supabase (https + realtime wss) and Razorpay');
check(has('frame-src', 'https://*.razorpay.com') && has('frame-src', 'https://www.youtube-nocookie.com') && has('frame-src', 'https://player.vimeo.com'), 'CSP frame-src: Razorpay, YouTube (no-cookie), Vimeo');
check(has('style-src', 'https://fonts.googleapis.com') && has('font-src', 'https://fonts.gstatic.com'), 'CSP fonts: Google Fonts CSS + files');
check(Object.keys(csp).includes('upgrade-insecure-requests'), 'CSP upgrade-insecure-requests');

// Every external script / frame / connection origin the source uses must be allowed.
const files = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (/\.(jsx?|tsx?)$/.test(e.name)) files.push(p); } };
walk('src');
const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');
const iframeOrigins = [...src.matchAll(/https:\/\/([a-z0-9.-]+)\/(?:embed|video)\//g)].map((m) => `https://${m[1]}`);
const allowedFrame = (o) => (csp['frame-src'] || []).some((s) => s === o || (s.startsWith('https://*.') && o.endsWith(s.slice(9))));
check(iframeOrigins.length > 0 && iframeOrigins.every(allowedFrame), `every embedded player origin is in frame-src (${[...new Set(iframeOrigins)].join(', ')})`);
check(!/new Function\(|[^.\w]eval\(/.test(src), 'application code uses no eval / new Function');
if (existsSync('dist/index.html')) {
  const html = readFileSync('dist/index.html', 'utf8');
  check(!/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(html), 'built index.html has no inline script (script-src needs no unsafe-inline)');
  check(existsSync('dist/staticwebapp.config.json'), 'the Azure config is copied into dist/');
}

console.log(failed ? `${failed} FAILED` : 'ALL SECURITY HEADER CHECKS PASSED');
process.exit(failed ? 1 : 0);
