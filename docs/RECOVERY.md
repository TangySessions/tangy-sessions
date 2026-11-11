# Production recovery — Phase 1

Recorded 2026-11-11. What was wrong, what this branch changes, and what must be
checked before anything is deployed.

## Where everything is

| Thing | Location | State |
|---|---|---|
| Full platform | `komalrubyjane/tangy-world`, branch `recovery/phase1-integration` | This branch: launch mode + responsive work (`ui/responsive-audit`) + production hardening (`claude/tangy-world-audit-rg8o4g`, 0037–0045) |
| Production database | Supabase `ohyjqxbsgdkzytfnlitf` | Recorded at 0045 (2026-10-06). Re-verify with the fingerprint below |
| Edge Functions | same project | **None deployed** (all seven answered 404, 2026-11-11) |
| Live website | `tangy-two.vercel.app` | Serves the old prototype `komalrubyjane/tangy`, not this repository |
| Prototype fix | `komalrubyjane/tangy`, branch `fix/stop-silent-submissions` | Prepared locally; not pushed or deployed |

`main` (`cbd1151`) has neither the launch-mode work nor 0037–0045. Until this
branch is merged, **never deploy Edge Functions from `main`**: its
`razorpay-create-order` ignores the hold that 0037 hands back and creates a
second Razorpay order for it, and its webhook releases seats on
`payment.failed`, which 0037/0038 no longer expect.

## What this branch changes

- Merges the hardening branch: migrations 0037–0045 with preflights,
  post-checks, rollbacks and DB tests; payment, check-in and console fixes;
  security headers (`vercel.json`, `public/staticwebapp.config.json`);
  host-independent build guards (`build-guards.js`). No textual conflicts; the
  only file both sides changed is `.env.example`.
- `src/config/launch.js`: reads `VITE_TEMPORARY_LAUNCH` and
  `VITE_TEMP_SESSION_FORM_URL` by name. It used to read the whole
  `import.meta.env` object, which made Vite inline **every** `VITE_` variable
  into the bundle, including `VITE_TEAM_REVIEW_PASSWORD` in builds where the
  guards compile review mode out.
- `razorpay-create-order`: the Razorpay order is attached only to a hold that
  is still `pending` with no order; otherwise 409 and the order is never
  shown to the browser (two overlapping checkouts from one account could
  otherwise hand out an order for a hold the second one had just replaced).
  Releasing seats after a failed order is limited the same way.
- `scripts/test-build-guards.mjs`: builds read `.env` files from an empty
  folder (`TANGY_ENV_DIR`), so a developer's `.env.local` can't change the
  result; new check that an unread `VITE_` variable never reaches the bundle.
- `supabase/ops/schema_fingerprint.readonly.sql`,
  `scripts/schema-fingerprint.sh`, `scripts/compare-schema-fingerprint.mjs`:
  object-by-object comparison of a database with the repository.

## Before any production action

### 1. Prove the production schema matches this branch (read-only)

1. Local (Docker): `scripts/test-fresh-db.sh` (builds `tangy_fresh` from the
   migrations and runs every DB test), then
   `scripts/schema-fingerprint.sh > expected.csv`.
2. Production, Supabase SQL editor: paste
   `supabase/ops/schema_fingerprint.readonly.sql` (one SELECT on system
   catalogs; no rows, no personal data). Optionally wrap it in
   `begin transaction read only; … rollback;`. Download the result as
   `production.csv`.
3. `node scripts/compare-schema-fingerprint.mjs expected.csv production.csv`
   → `SCHEMA MATCHES`, or the exact functions, triggers, policies, tables,
   grants, enums or buckets that differ.

Also run `supabase/production-bootstrap/checks/production_inventory.readonly.sql`
(per-migration presence) and `supabase/ops/payments_and_webhooks.readonly.sql`
(bookings and payments by state, no personal data).

Known, expected difference: production has no 0004 seed events and none of the
0017 / 0028 seed rows (rows are not fingerprinted).

A mismatch means **stop**: nothing is deployed until it is explained. Never
re-run a migration that the inventory reports as applied.

### 2. Merge

Merge `recovery/phase1-integration` into `main` (pull request), so `main`
matches production again.

### 3. Then, in this order (each needs approval)

1. Website: point the production domain at a Vercel project built from this
   repository (launch mode on), with the variables in `docs/LAUNCH.md`.
2. Edge Functions: deploy from `main` after the merge (`docs/OPERATIONS.md`
   §3a) with **Razorpay test keys only**.
3. Run the Razorpay test scenarios (§3, V1–V8) before any live key.

## The old prototype (`tangy-two.vercel.app`)

Found 2026-11-11:
- The booking form asked visitors to pay by UPI to a phone number, then
  POSTed their details with `mode: "no-cors"` to a Google Form that is
  **closed** (`…/closedform`), using placeholder field ids, and showed
  "BOOKING CONFIRMED". No booking was recorded anywhere.
- Volunteer applications were POSTed the same way with placeholder ids.
- Sign-in accepted any email with the fixed code `123456`; `/admin`,
  `/artist`, `/profile`, `/onboarding` showed mock data.

**Manual action:** compare UPI payments received on the number shown on the
site against your records for every session since that form closed. Those
visitors paid without any booking being saved.

The fix on `fix/stop-silent-submissions` (built and checked in Chrome):
registration closed with a "please don't pay" notice and a contact address;
volunteer page links to the real Google Form; sign-in, admin, artist,
profile and onboarding show "coming soon". Deploying it (push + Vercel) needs
approval. The lasting fix is to serve this repository on the domain instead.

Contact address mismatch to resolve: the prototype uses
`hello@tangysessions.in`, this repository `hello@tangysessions.com`.
