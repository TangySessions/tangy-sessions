// TEAM REVIEW MODE — temporary review deployments only (see vite.config.js).
// `__TANGY_REVIEW_MODE__` is fixed at build time: false unless the build sets
// VITE_TEAM_REVIEW_MODE=true, and a production build (any host — build-guards.js) refuses that unless
// TANGY_ALLOW_REVIEW_BUILD=1. When false, the demo login and everything below
// is dead code. The accounts are the disposable demo accounts loaded into the
// review project by `DEMO_TARGET=review scripts/demo-data.sh seed`; their
// shared password comes from VITE_TEAM_REVIEW_PASSWORD (hosting settings, never Git).
// Sign-in is a real Supabase session, so every role restriction is the real one.
export const TEAM_REVIEW_MODE = __TANGY_REVIEW_MODE__;
export const TEAM_REVIEW_PASSWORD = TEAM_REVIEW_MODE ? import.meta.env.VITE_TEAM_REVIEW_PASSWORD : undefined;

export const REVIEW_ACCOUNTS = [
  { role: 'super_admin', label: 'Super Admin', name: 'Komal Tej', email: 'director@demo.tangy.local', path: '/admin-portal', tagline: 'Everything: users and roles, settings, audit, all operations' },
  { role: 'admin', label: 'Admin / Manager', name: 'Tangy Manager', email: 'ops@demo.tangy.local', path: '/admin-portal', tagline: 'Events, artists, bookings, content, messages' },
  { role: 'staff', label: 'Staff', name: 'Tangy Staff', email: 'desk@demo.tangy.local', path: '/admin-portal', tagline: 'Assigned events, check-in, tasks' },
  { role: 'artist', label: 'Artist', name: 'Ananya Rao', email: 'ananya.rao@demo.tangy.local', path: '/artist/dashboard', tagline: 'Artist portal: sessions, calendar, requests, messages' },
  { role: 'sponsor', label: 'Sponsor', name: 'Kavya Reddy · Saffron Tea', email: 'saffron.tea@demo.tangy.local', path: '/sponsor/dashboard', tagline: 'Sponsorships, deliverables, brand assets' },
  { role: 'vendor', label: 'Vendor', name: 'Ravi Kumar · Kulhad Chai', email: 'kulhad.chai@demo.tangy.local', path: '/vendor/dashboard', tagline: 'Assigned events, logistics, invoices' },
  { role: 'venue', label: 'Venue Host', name: 'Farah Siddiqui', email: 'farah@demo.tangy.local', path: '/venue/dashboard', tagline: 'Hosted events, setup and access' },
  { role: 'volunteer', label: 'Volunteer', name: 'Aisha Begum', email: 'aisha@demo.tangy.local', path: '/volunteer/dashboard', tagline: 'Shifts, notices, check-in access tonight' },
  { role: 'customer', label: 'Customer', name: 'Meera Kulkarni', email: 'meera.kulkarni@demo.tangy.local', path: '/dashboard', tagline: 'Bookings, tickets, passport, waitlist offer' },
];
