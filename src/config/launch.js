// TEMPORARY PUBLIC LAUNCH MODE — one switch for the controlled launch.
// See docs/LAUNCH.md for what it changes and how to turn it off.
//
// While on, the public site keeps its content (story, archive, gallery, TV,
// artists, team) but:
//   - no session from the events table is listed or bookable publicly
//     (useEvents returns nothing; /sessions/:id shows "Coming soon");
//   - /sessions ("Book Now") shows the one TEMPORARY_SESSION below, whose
//     button opens the team's Google Form — never checkout or Razorpay;
//   - public sign-in/sign-up, the Passport, partner dashboards and the artist
//     portal show "Coming soon", and forms that need sign-in say so;
//   - placeholder forms that save nothing (Inner Circle, postcard) are replaced
//     by a "Coming soon" note.
// The admin console (/admin-portal), its own sign-in, staff check-in and staff
// invitations are not affected, and no database data is touched.
//
// It is ON unless the build sets VITE_TEMPORARY_LAUNCH=false, so a deploy
// can't fall back to the full site by accident. `import.meta.env` is absent
// when Node imports this file (e2e/navigation.mjs via siteNav.js).
//
// Each variable is read by its full static name, never through the whole
// `import.meta.env` object: Vite inlines only the names it sees, but a
// reference to the bare object inlines EVERY VITE_ variable into the bundle
// (including VITE_TEAM_REVIEW_PASSWORD, which the build guards compile out of
// production). scripts/test-build-guards.mjs checks the bundle for this.
let launchFlag;
let formUrlRaw;
try {
  launchFlag = import.meta.env.VITE_TEMPORARY_LAUNCH;
  formUrlRaw = import.meta.env.VITE_TEMP_SESSION_FORM_URL;
} catch {
  // Node (no import.meta.env): defaults below — launch mode on, no form.
}

export const LAUNCH_MODE = launchFlag !== 'false';

// Shown wherever a feature is held back for the launch.
export const COMING_SOON_EMAIL = 'hello@tangysessions.com';

// The one session shown on /sessions during the launch. Fill in ONLY what the
// team has confirmed; every field left null is simply not shown (the card
// never guesses a date, venue, price or line-up). Do not copy an old session's
// details here. `image` is a path under public/ (e.g. '/media/opt/...webp').
export const TEMPORARY_SESSION = {
  title: null,
  description: null,
  date: null, // free text as it should read, e.g. 'Saturday, 14 November 2026'
  time: null, // e.g. '6:30 PM onwards'
  venue: null,
  price: null, // e.g. '₹499' or 'Free entry'
  artists: null, // e.g. 'Artist A · Artist B'
  image: null,
};

// Only Google Forms links are accepted: https://docs.google.com/forms/... or
// https://forms.gle/<id>. The URL comes from the build environment, never from
// the visitor, so this is not an open redirect — the check stops a typo or a
// wrong link from sending visitors somewhere unexpected.
const DOCS_FORM_PATH = /^\/forms\/(u\/\d+\/)?d\/(e\/)?[\w-]+(\/(viewform|formResponse))?\/?$/;
const SHORT_FORM_PATH = /^\/[\w-]+\/?$/;

export function toGoogleFormUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const ok = (url.hostname === 'docs.google.com' && DOCS_FORM_PATH.test(url.pathname))
    || (url.hostname === 'forms.gle' && SHORT_FORM_PATH.test(url.pathname));
  return ok ? url.href : null;
}

// Set VITE_TEMP_SESSION_FORM_URL in Vercel (Production + Preview) and redeploy.
// Missing or not a Google Forms link → null, and the card shows
// "Registration opens soon" instead of a button.
export const TEMP_SESSION_FORM_URL = toGoogleFormUrl(formUrlRaw);
