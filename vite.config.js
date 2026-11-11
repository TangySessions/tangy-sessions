import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { deployTarget, assertBackendConfigured, reviewMode as reviewModeFor, demoAdmin as demoAdminFor } from './build-guards.js'

// DEVELOPMENT-ONLY: the admin console's dev role switcher (src/admin/dev/).
// `__TANGY_DEV_TOOLS__` is true only for `vite` (serve). Every `vite build`
// (any --mode) and `vite preview` gets false, so the switcher and mock
// identities are compiled out of production bundles.
const DEV_IDENTITIES = {
  super_admin: { email: 'superadmin@tangy.local', full_name: 'Tangy Super Admin' },
  admin: { email: 'admin@tangy.local', full_name: 'Tangy Admin' },
  staff: { email: 'staff@tangy.local', full_name: 'Tangy Staff' },
  // The artist button signs in as the populated demo artist (scripts/demo-data.sh): sessions,
  // requests, calendar, messages and notifications to explore. Seeded locally only.
  artist: { email: 'ananya.rao@demo.tangy.local', full_name: 'Ananya Rao' },
  sponsor: { email: 'sponsor@tangy.local', full_name: 'Tangy Sponsor' },
  vendor: { email: 'vendor@tangy.local', full_name: 'Tangy Vendor' },
  venue: { email: 'venue@tangy.local', full_name: 'Tangy Venue Host' },
  volunteer: { email: 'volunteer@tangy.local', full_name: 'Tangy Volunteer' },
}

// Partner portals open only for approved accounts, exactly as in production:
// give each local test identity the approved application + profile row that
// a real approval would create. Local stack only (guarded below).
async function provisionPartner(api, role, userId, who) {
  const exists = async (path) => (await (await api(path, 'GET')).json()).length > 0
  const ensure = async (table, query, row) => {
    if (!(await exists(`/rest/v1/${table}?${query}&select=*&limit=1`))) await api(`/rest/v1/${table}`, 'POST', row, { Prefer: 'return=minimal' })
  }
  const collab = { sponsor: 'sponsor', vendor: 'vendor', venue: 'venue_host' }[role]
  if (role === 'artist') {
    await ensure('artists', `user_id=eq.${userId}`, { user_id: userId, name: who.full_name, email: who.email, genre: 'Live', city: 'Hyderabad', status: 'approved' })
  } else if (collab) {
    await ensure('collaborations', `user_id=eq.${userId}&type=eq.${collab}`, { user_id: userId, type: collab, business_name: who.full_name, contact_name: who.full_name, email: who.email, status: 'approved' })
    const [table, nameCol] = { sponsor: ['sponsor_profiles', 'organization_name'], vendor: ['vendor_profiles', 'business_name'], venue: ['venue_profiles', 'property_name'] }[role]
    await ensure(table, `id=eq.${userId}`, { id: userId, [nameCol]: who.full_name })
  } else if (role === 'volunteer') {
    await ensure('crew_applications', `user_id=eq.${userId}&category=eq.volunteer`, { user_id: userId, name: who.full_name, email: who.email, role_interest: 'Volunteer', category: 'volunteer', status: 'approved' })
    await ensure('volunteer_profiles', `id=eq.${userId}`, { id: userId })
  }
}const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

// Signs the browser into a matching account on a LOCAL Supabase stack, so
// data and RLS are real while switching roles without OTP. Serve-only
// middleware; it refuses unless the request is from this machine AND
// VITE_SUPABASE_URL points at localhost. The service key is read from the
// dev server's env (SUPABASE_SERVICE_ROLE_KEY) and never reaches the browser.
function devMockSession(env) {
  return {
    name: 'tangy-dev-mock-session',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/mock-session', async (req, res) => {
        const reply = (status, body) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        try {
          if (req.method !== 'POST') return reply(405, { reason: 'POST only' })
          if (!LOOPBACK.has(req.socket.remoteAddress)) return reply(403, { reason: 'local requests only' })
          let base
          try { base = new URL(env.VITE_SUPABASE_URL) } catch { return reply(409, { reason: 'VITE_SUPABASE_URL is not set' }) }
          if (!LOOPBACK.has(base.hostname)) return reply(409, { reason: 'backend is not a local Supabase stack' })
          const key = env.SUPABASE_SERVICE_ROLE_KEY
          if (!key) return reply(409, { reason: 'SUPABASE_SERVICE_ROLE_KEY is not set for the dev server' })

          let raw = ''
          for await (const chunk of req) raw += chunk
          const role = JSON.parse(raw || '{}').role
          const who = DEV_IDENTITIES[role]
          if (!who) return reply(400, { reason: 'unknown role' })

          const api = (path, method, body, extra = {}) => fetch(`${base.origin}${path}`, {
            method,
            headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra },
            body: body && JSON.stringify(body),
          })
          // Idempotent: 422 just means the local account already exists.
          await api('/auth/v1/admin/users', 'POST', { email: who.email, email_confirm: true, user_metadata: { full_name: who.full_name } })
          const link = await api('/auth/v1/admin/generate_link', 'POST', { type: 'magiclink', email: who.email })
          const data = await link.json()
          const userId = data.id || data.user?.id
          const tokenHash = data.hashed_token || data.properties?.hashed_token
          if (!link.ok || !userId || !tokenHash) return reply(502, { reason: data.msg || 'could not create a local session' })
          const upd = await api(`/rest/v1/profiles?id=eq.${userId}`, 'PATCH', { role, full_name: who.full_name, is_active: true }, { Prefer: 'return=minimal' })
          if (!upd.ok) return reply(502, { reason: `could not set local role (${upd.status})` })
          await provisionPartner(api, role, userId, who)
          return reply(200, { token_hash: tokenHash })
        } catch (err) {
          return reply(500, { reason: err.message })
        }
      })
    },
  }
}

// Every VITE_ variable is compiled into the browser bundle (and served to the
// browser in dev). A Supabase secret / service_role key there would hand
// anyone full database access past RLS, so it stops dev and build alike.
function assertNoSecretInBrowserEnv(env) {
  const roleOf = (jwt) => {
    try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).role } catch { return null }
  }
  const leaked = Object.keys(env).filter((k) => k.startsWith('VITE_') && env[k] && (
    env[k].startsWith('sb_secret_')
    || (env[k].split('.').length === 3 && roleOf(env[k]) === 'service_role')
    || (env.SUPABASE_SERVICE_ROLE_KEY && env[k] === env.SUPABASE_SERVICE_ROLE_KEY)))
  if (leaked.length) {
    throw new Error(`[tangy] ${leaked.join(', ')} holds a Supabase secret / service_role key. VITE_ variables are public: use the publishable (or anon) key, and keep secret keys server-side only.`)
  }
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  assertNoSecretInBrowserEnv(env)
  // Production unless the build explicitly says otherwise (build-guards.js) —
  // the same on Vercel, Azure or any other host.
  const target = deployTarget(env)
  const warn = (msg) => msg && console.warn(`\n[tangy] ${msg}\n`)
  if (command === 'build') warn(assertBackendConfigured(env, target))
  // Feature guards below switch the feature OFF in the bundle (with a warning)
  // instead of failing the build, so a stray hosting variable can never break
  // a deployment and can never ship a demo login either. (A missing backend
  // or a secret in a VITE_ variable, above, does fail.)
  const demo = demoAdminFor(env, target, command)
  warn(command === 'build' && demo.warning)
  const review = reviewModeFor(env, target, command)
  warn(review.warning)
  const demoAdmin = demo.enabled
  const reviewMode = review.enabled
  return {
    plugins: [react(), tailwindcss(), devMockSession(env)],
    // TANGY_DEV_TOOLS=off serves a dev build without the switcher (used by e2e/).
    define: {
      __TANGY_DEV_TOOLS__: JSON.stringify(command === 'serve' && env.TANGY_DEV_TOOLS !== 'off'),
      __TANGY_REVIEW_MODE__: JSON.stringify(reviewMode),
      'import.meta.env.VITE_DEMO_ADMIN_ENABLED': JSON.stringify(demoAdmin ? 'true' : 'false'),
    },
  }
})
