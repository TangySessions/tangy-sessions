# Tangy World: Production Status

Repo: `komalrubyjane/tangy-world` · Branch: `recovery/phase1-integration` · Updated: 2026-11-11

---

## ✅ Done

### Code and database
- [x] Database migrations **0001–0045** are written. Production hardening (0037–0045) is merged into the launch-mode branch (commit `030932d`).
- [x] Booking holds allow **one active hold per account**, enforced with an advisory lock (0037).
- [x] **Row-level security** is on. SECURITY DEFINER functions use a fixed `search_path`.
- [x] The following were reviewed and look sound: `settle_payment`, `create_pending_booking`, `is_assigned_to_event`, `check_in_ticket`.
- [x] Commit `51985d3`:
  - stops a `VITE_` environment-variable leak
  - adds a guard on attaching orders
  - adds the schema fingerprint tools

### Payments (Razorpay)
- [x] `razorpay-create-order` was reviewed.
- [x] `razorpay-verify-payment` checks the HMAC signature (reviewed).
- [x] `razorpay-webhook` checks the HMAC over the raw body, skips duplicate events by signed ID, and calls `settle_payment` (reviewed).
- [x] "BOOKING CONFIRMED" appears only after the server verifies the payment.

### Frontend and security
- [x] **Launch mode** (`VITE_TEMPORARY_LAUNCH`): "Book now" goes to a temporary form while the full flow stays held back.
- [x] Vite **build guards** (`build-guards.js`) block unsafe production builds.
- [x] A **Content Security Policy** and security headers are set in `vercel.json`.

### Ops tooling
- [x] Schema fingerprint tools:
  - `supabase/ops/schema_fingerprint.readonly.sql`
  - `scripts/schema-fingerprint.sh`
  - `scripts/compare-schema-fingerprint.mjs`

### Testing
- [x] Database tests pass. The race-condition and offline tests also pass.
- [x] **6 end-to-end suites** pass on the local stack.
- [x] Local Supabase stack runs with Docker.

### Repo housekeeping
- [x] Checked that every branch is in sync with GitHub. Only this branch has unpushed work.

---

## ⏳ Yet to do

### A. Finish the code (Claude, with your approval)
- [ ] **Commit the 5 changed files:**
  - `e2e/checkout.mjs`
  - `e2e/staff_setup.sql`
  - `src/admin/pages/ReportsPage.jsx`
  - `supabase/tests/storage_lifecycle.test.sql`
  - `supabase/tests/ticket_email_outbox.test.sql`
- [ ] **Push** `recovery/phase1-integration` (2 local commits are unpushed).
- [ ] **Run the remaining 15 end-to-end suites.**
- [ ] **Open a pull request and merge to `main`.**

### B. Production database check (blocks deploy)
- [ ] **You:** run `supabase/ops/schema_fingerprint.readonly.sql` in the Supabase SQL Editor. It only reads, and returns no customer data. Download the result as CSV.
- [ ] **Claude:** compare the CSV against migrations 0001–0045 and report any differences.

### C. Supabase backend
- [ ] **Deploy the 7 Edge Functions** (they currently return 404):
  - `razorpay-create-order`
  - `razorpay-verify-payment`
  - `razorpay-webhook`
  - `send-ticket-email`
  - `send-approval-email`
  - `send-notification-emails`
  - `admin-invite-user`
- [ ] **Set the Edge Function secrets:**
  - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
  - `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`
  - `SITE_URL`, `ALLOWED_ORIGINS`, `CRON_SECRET`
- [ ] **Confirm `pg_cron` runs the platform jobs:** expiring holds, the waitlist and reminders.
- [ ] **Schedule `send-notification-emails`** to run every 1–2 minutes with the `x-cron-secret` header.

### D. Third-party accounts (you)
- [ ] **Razorpay:**
  - register the webhook URL in the dashboard
  - make one **test-mode payment**
- [ ] **Resend:** verify the sending domain with SPF, DKIM and DMARC records.

### E. Hosting
- [ ] **Decide where Tangy World will be deployed, and on which domain.** It isn't live anywhere yet.
- [ ] **Create a Vercel project for the tangy-world repo.**
- [ ] **Set the Vercel environment variables:**
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_PUBLISHABLE_KEY`
  - `VITE_TEMP_SESSION_FORM_URL`
- [ ] **Connect the domain**, then make `SITE_URL` and `ALLOWED_ORIGINS` match it.

### F. Go-live checks
- [ ] **Invite the real admins and staff**, and check each person's role permissions.
- [ ] **Full test-mode rehearsal:**
  - booking → payment → ticket email → QR code → check-in
  - a failed payment, then a retry
- [ ] **Switch Razorpay to live keys.**
- [ ] **For the first few days, monitor:**
  - email delivery
  - the payment-review queue

### Should do (not blockers)
- [ ] **Payment edge case:** someone who pays an old checkout after starting a new one for the same session can be charged twice. It's rare, and the money is never lost. Decide how to handle it.
- [ ] **Exclude the inert demo-admin page** from production builds.
- [ ] **Make the cron-secret check timing-safe.**
- [ ] **Remove the unused `VITE_RAZORPAY_KEY_ID`.**
- [ ] **Fix the contact email:**
  - `tangysessions.in` has no mail setup
  - either use `tangysessions.com` or add mail records for `.in`

---

## Next step
1. Approve the commit and push (section A).
2. In parallel, run the schema query and send the CSV (section B). Everything from section C onward depends on that check.
