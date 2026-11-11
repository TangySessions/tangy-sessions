# Tangy World — operations guide

Everything here has been verified on the **local** stack only. Nothing has been
deployed, no production migration has been applied, and no production secret
has been configured. Values below are intentionally left empty.

## 1. Scheduled jobs

| Work | Where it runs | Schedule | Idempotent / safe to retry | Audited |
| --- | --- | --- | --- | --- |
| Expire unpaid checkout holds (`expire_stale_bookings`) — releases seats, notifies the customer, offers seats to the waitlist | `run_platform_jobs()` (also runs before every new checkout) | pg_cron every 5 min (0020) | yes — only `pending` rows past the hold are touched | `booking.expired` audit rows, `platform_job_runs` |
| Expire waitlist offers (`expire_waitlist_offers`) — notifies the holder, offers the seats onwards | `run_platform_jobs()` | every 5 min | yes — `offered` rows past `offer_expires_at` only; `FOR UPDATE SKIP LOCKED` | `waitlist.offered` audits, run log |
| Expire unanswered artist booking requests | `run_platform_jobs()` | every 5 min | yes | run log |
| Event reminders | `run_platform_jobs()` | every 5 min | yes — `event_reminders_sent` de-duplicates | run log |
| Overdue task / expiring volunteer access notices | `run_platform_jobs()` | every 5 min | yes — `overdue_notified_at` / `expiring_notified_at` markers | run log |
| Log expired temporary check-in access | `run_platform_jobs()` | every 5 min | yes — `expiry_logged_at` marker | `access.expired` audits |
| Send queued emails (`email_outbox`) | Edge Function `send-notification-emails` | external scheduler / Supabase Cron HTTP, every 1–2 min, header `x-cron-secret` | yes — rows claimed with `FOR UPDATE SKIP LOCKED`, retried up to 5×; **without an email provider the queue is left untouched** | per-row status + error in `email_outbox` (Admin → More operations → Email delivery) |
| Scheduled publishing (TV, diary, gallery, announcements) | none needed — visibility is `status = 'published' and published_at <= now()` evaluated at read time | — | — | content audits |
| Payment reconciliation | none on a schedule — `razorpay-webhook` is the source of truth and calls `settle_payment()` idempotently; mismatches go to finance review | on each webhook | yes | `payment.*` audits, `payment_webhook_events` |

`run_platform_jobs(source)` (0029) takes a transaction-scoped advisory lock: a run that overlaps another is **skipped and recorded**, never doubled. Every run is written to `platform_job_runs` (readable with `operations.manage`).

Local: `scripts/run-jobs.sh` (add `emails` to also drain the outbox). Tests: `supabase/tests/media_realtime_jobs.test.sql` (run once, run twice, expired and already-processed records) and `scripts/test-concurrency.sh` (overlapping runs, last-seat race, offer race across two real sessions).

Production: confirm pg_cron is enabled (0020 schedules `tangy-platform-jobs`); otherwise call `select public.run_platform_jobs('scheduler')` every 5 minutes with the service role. Schedule the email function separately (section 2).

## 2. Email — production configuration (not done yet)

Edge Function secrets (`supabase secrets set …`), never `VITE_` variables:

```
EMAIL_PROVIDER=resend
RESEND_API_KEY=
EMAIL_FROM=
EMAIL_REPLY_TO=
SITE_URL=
CRON_SECRET=
```

- [ ] Create the Resend account and verify the sending domain (SPF, DKIM, DMARC records).
- [ ] Set the secrets above; `EMAIL_FROM` must use the verified domain.
- [ ] Deploy `send-notification-emails` (`--no-verify-jwt`; it checks the service key / `CRON_SECRET` itself), `send-ticket-email`, `send-approval-email`.
- [ ] Schedule a POST to `send-notification-emails` every 1–2 minutes with header `x-cron-secret` (step-by-step: §2a).
- [ ] Send one real ticket email and one approval email to a team inbox; check links (`SITE_URL`), QR attachment and reply-to.
- [ ] Watch Admin → Email delivery for failures for the first days.

Until then: nothing is sent and nothing crashes; queued emails wait (`scripts/test-email-config.mjs` checks this). Email bodies never contain message text, payment details or booking answers.

## 2a. Production runbook — scheduled jobs and the email queue

Project `ohyjqxbsgdkzytfnlitf`. Every step is done by a person in the Supabase
dashboard or with the Supabase CLI; nothing here re-runs a migration or changes
RLS, policies, functions, triggers or the schema. Two schedules matter:

- **`tangy-platform-jobs`** (pg_cron, every 5 min) → `run_platform_jobs()`:
  expires unpaid checkout holds (releasing seats), waitlist offers and artist
  requests, sends reminders and notices. Without it, seats held by abandoned
  checkouts are only released when someone else starts a checkout.
- **The email drain** (every 1–2 min) → Edge Function `send-notification-emails`,
  which sends what `notify()` queued in `email_outbox` **and every ticket
  confirmation email** (queued by `razorpay-webhook` / `razorpay-verify-payment`
  once a payment is settled — see "Ticket email" below). Without it, in-app
  notifications work but **no notification or ticket email is ever sent**.

### Step 0 — look before changing anything

Run `supabase/ops/scheduled_jobs_and_email.readonly.sql` in the SQL editor
(one SELECT; it can be wrapped in `begin transaction read only; … rollback;`).
It reports pg_cron / pg_net, both schedules and their recent runs, the job-run
log and the outbox by status. It never shows addresses, email content or a
cron job's command (which holds the cron secret). Note rows 1, 3 and 8.

### Step 1 — platform jobs (`tangy-platform-jobs`)

- Row 3 shows `*/5 * * * * (active)` → nothing to do; after 10 minutes row 5
  shows successes and row 7 a recent `last finished`.
- Row 3 shows **pg_cron not installed** or **MISSING**: enable `pg_cron` under
  Database → Extensions, then create the same job 0020 creates — either
  Integrations → Cron → *Create job* → name `tangy-platform-jobs`, schedule
  `*/5 * * * *`, type *SQL snippet* `select public.run_platform_jobs()`; or in
  the SQL editor:
  `select cron.schedule('tangy-platform-jobs', '*/5 * * * *', 'select public.run_platform_jobs()');`
  (re-running it with the same name updates the job instead of adding one).
- Row 4 (`tangy-log-expired-access`, 0018) may or may not exist; it is
  redundant with `run_platform_jobs()` and harmless either way.

### Step 2 — email secrets

Prerequisite: a Resend account with the sending domain verified (SPF, DKIM,
DMARC). Then, with the CLI linked to the project (`supabase link --project-ref
ohyjqxbsgdkzytfnlitf`), set the Edge Function secrets — never as `VITE_`
variables, never in Git:

```
openssl rand -hex 32          # → the CRON_SECRET value; keep it in your password manager
supabase secrets set EMAIL_PROVIDER=resend RESEND_API_KEY=re_… \
  EMAIL_FROM="Tangy Sessions <hello@your-verified-domain>" SITE_URL=https://<production site> \
  CRON_SECRET=<the value above>
# optional: EMAIL_REPLY_TO=…
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase; do
not set them. Without `RESEND_API_KEY` the function answers
`{"configured": false}` and leaves the queue untouched.

### Step 3 — deploy the function

```
supabase functions deploy send-notification-emails --no-verify-jwt
```

`--no-verify-jwt` is required: the scheduler authenticates with the
`x-cron-secret` header, which the function checks itself (end-user sessions are
always refused). Deployed *with* JWT verification, the platform gateway rejects
every scheduled call with 401 before the function runs.

### Step 4 — smoke-test by hand

Read the secret without leaving it in shell history, then call the function:

```
read -rs CRON_SECRET
URL=https://ohyjqxbsgdkzytfnlitf.supabase.co/functions/v1/send-notification-emails
curl -s -X POST "$URL" -H "x-cron-secret: $CRON_SECRET" -H 'Content-Type: application/json' -d '{}'
#   → {"claimed":0,"sent":0,"failed":0}  (configured; {"configured":false} means RESEND_API_KEY is missing)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" -d '{}'          # → 403 (no secret)
curl -s -o /dev/null -w '%{http_code}\n' "$URL"                          # → 405 (GET)
unset CRON_SECRET
```

### Step 5 — schedule the drain

Integrations → Cron → *Create job* (enable `pg_net` when the dashboard asks):

| Field | Value |
| --- | --- |
| Name | `tangy-email-drain` |
| Schedule | `* * * * *` (or `*/2 * * * *`) |
| Type | *Supabase Edge Function* (or *HTTP request* to the URL above) |
| Method / function | `POST` / `send-notification-emails` |
| Headers | `x-cron-secret: <CRON_SECRET>` (plus `Content-Type: application/json`) |
| Body | `{}` |

Each run sends at most 25 emails; overlapping runs never send one twice. The
secret is stored in the job's command (`cron.job`, readable only by
database-owner roles): after rotating `CRON_SECRET`, edit the job too.
An external scheduler that POSTs the same request every 1–2 minutes works as
well.

### Step 6 — verify

1. Re-run the Step 0 check: row 8 lists `tangy-email-drain (active)`, row 9
   shows successes, row 13 shows 2xx responses and no 4xx (a 401 means the
   function was deployed with JWT verification; a 403 means the header or
   secret is wrong).
2. End to end: as Super Admin, open another active team member's account in
   Admin → Users and send them a custom notification (the form is not shown on
   your own account). Within two minutes it reaches their inbox, row 10 shows
   it as `sent`, and the link opens `SITE_URL`.
3. For the first days, check Admin → More operations → Email delivery for
   `failed` rows (row 12 shows the latest error, addresses masked).

## 3. Razorpay — production checklist (not done yet)

Secrets: `RAZORPAY_KEY_ID=` `RAZORPAY_KEY_SECRET=` `RAZORPAY_WEBHOOK_SECRET=` (all empty today). Without the key pair checkout answers 503 and releases the seats; without the webhook secret the webhook refuses every call (503) — a missing secret is never used as a key.

Architecture (verified locally): the server prices every booking (`booking_quote`, the browser's amount is ignored); ticket-type and event capacity are enforced under the event row lock; held waitlist seats count against capacity; `settle_payment()` confirms idempotently and sends late / wrong-amount / cancelled / expired-and-resold payments to finance review (`payment.review` alert) instead of over-selling; webhook deliveries are de-duplicated by event id; signatures are HMAC-SHA256 compared in constant time. No automatic refunds are made.

When real test-mode credentials exist, run and record each of these (none has been run against Razorpay yet):

1. [ ] Successful payment → booking confirmed once, tickets issued, ticket email queued.
2. [ ] Failed payment → nothing confirmed; retry works.
3. [ ] Abandoned checkout → hold expires after `bookings.pending_timeout_minutes`, seats released (and offered to the waitlist).
4. [ ] Duplicate webhook delivery → processed once (`payment_webhook_events`).
5. [ ] Delayed webhook (verify-payment first, webhook later) → single confirmation.
6. [ ] Wrong amount (edit the order amount in test mode) → `needs_review`, finance alerted.
7. [ ] Late payment after the hold expired, seats still free → confirmed with `payment.late_accepted` audit.
8. [ ] Payment for a booking cancelled by an admin → `needs_review`.
9. [ ] Two customers racing for the last seat → one checkout, one "sold out".
10. [ ] Waitlist seat collision: a held seat cannot be bought by someone else; a late payment cannot take it.
11. [ ] Subscribe the webhook to `payment.captured`, `order.paid`, `payment.failed`, `payment.authorized`, `refund.processed`, `refund.created`; compare payload fields with Razorpay's "recent deliveries".
12. [ ] A refund made in the Razorpay dashboard is recorded in Tangy (`admin_record_refund`) and mirrored by the webhook.

## 3a. Production runbook — Edge Functions and Razorpay

Project `ohyjqxbsgdkzytfnlitf`. Nothing here has been deployed yet: the
repository has no `supabase/config.toml`, no linked project ref, no CI and no
deploy script, so every step below is an **operator action** (Supabase CLI,
Supabase dashboard, Razorpay dashboard, Resend). Nothing here changes a
migration, RLS, a policy, a function, a trigger or the schema.

### Which functions, and how they are called

| Function | Called by | Gateway JWT check | Service-role key | External service | Must exist for |
| --- | --- | --- | --- | --- | --- |
| `razorpay-create-order` | browser (`src/lib/bookingService.js`) | keep (default) | yes — after `auth.getUser()`, to read the event and call `create_pending_booking` (service-role only) | Razorpay Orders API | checkout |
| `razorpay-verify-payment` | browser (`bookingService.js`) | keep | yes — after `auth.getUser()` + own-booking check, to call `settle_payment` (service-role only) | none (HMAC with `RAZORPAY_KEY_SECRET`) | checkout |
| `razorpay-webhook` | Razorpay | **off** (`--no-verify-jwt`): Razorpay sends no Supabase JWT; the function verifies `X-Razorpay-Signature` itself | yes — after the signature check | none | payment source of truth |
| `send-ticket-email` | browser after a verified payment (no-op when the email is already queued); admin "resend" (`Bookings.jsx`, always sends) | keep | yes — after `auth.getUser()` + owner / active admin / active staff assigned to the booking's event | Resend; `qrcode` from esm.sh | ticket email resend / fallback |
| `send-approval-email` | admin (`src/services/notificationService.js`) | keep | yes — after `auth.getUser()` + active admin role check | Resend | application decisions |
| `admin-invite-user` | admin (`src/admin/api.js`) | keep | **no** — runs entirely under the inviter's JWT | Resend | console invitations |
| `send-notification-emails` | scheduler (§2a) | **off** (`--no-verify-jwt`): checks `x-cron-secret` (or the service key) itself | yes — after that check | Resend | notification email |

Every function with the gateway check kept also verifies the caller in code
(`auth.getUser()`); the two without it verify a signature / shared secret
before doing anything.

### Secrets — exact names read by the code

Edge Function secrets (`supabase secrets set NAME=value`). **None of them may
be a `VITE_` variable or appear in the hosting build environment (Vercel / Azure)**: `vite build` refuses a Supabase
secret key in a `VITE_` variable, and a canary build confirms no function
secret reaches the browser bundle.

| Name | Read by | Notes |
| --- | --- | --- |
| `RAZORPAY_KEY_ID` | `razorpay-create-order` | Public key id (`rzp_test_…` / `rzp_live_…`). Returned to the browser in the order response — that is the only way the browser gets it; it is not a secret. |
| `RAZORPAY_KEY_SECRET` | `razorpay-create-order` (Orders API auth), `razorpay-verify-payment` (signature) | Secret. Without it (or the key id) checkout answers 503 and releases the seats; verify answers 503. |
| `RAZORPAY_WEBHOOK_SECRET` | `razorpay-webhook` | Secret. The value you type into the Razorpay webhook form — **not** the key secret. Without it every delivery gets 503. |
| `RESEND_API_KEY` | `_shared/email.ts` (all email functions) | Secret. Without it email is "not configured": nothing is sent, nothing crashes. |
| `EMAIL_FROM` | `_shared/email.ts` | e.g. `Tangy Sessions <hello@your-verified-domain>`; must use the Resend-verified domain. Old name `RESEND_FROM_EMAIL` is still read. Default `Tangy Sessions <hello@tangysessions.com>`. |
| `EMAIL_PROVIDER` | `_shared/email.ts` | `resend` (default — can be left unset). `log` / `disabled` / `mailpit` are for development. |
| `EMAIL_REPLY_TO` | `_shared/email.ts` | Optional. |
| `SITE_URL` | `_shared/cors.ts` (browser functions), `send-approval-email`, `send-notification-emails`, `admin-invite-user` | The exact origin of the production site, e.g. `https://www.example.com` (no trailing slash). Used as the CORS allow-list **and** for links in emails. `admin-invite-user` refuses (503) without it. If neither it nor `ALLOWED_ORIGINS` is set, CORS allows only `http://localhost` / `http://127.0.0.1` (local development), so the production site's calls fail. |
| `ALLOWED_ORIGINS` | `_shared/cors.ts` | Optional, comma-separated; replaces `SITE_URL` as the CORS allow-list only (emails keep using `SITE_URL`). Set it only when the site is served from more than one origin — see "CORS" below. |
| `CRON_SECRET` | `send-notification-emails` | Secret shared with the scheduler (§2a). |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | all functions | **Injected by Supabase — do not set.** |
| `MAILPIT_URL` | `_shared/email.ts` | Local stack only. |

The browser build (Vercel or Azure) needs only `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` (or the legacy `VITE_SUPABASE_ANON_KEY`).
`VITE_RAZORPAY_KEY_ID` is not read by the app and can stay unset.

**CORS.** Every browser-called function answers a request (preflight and
response alike) with **that request's own origin when it is on the allow-list**,
and with no `Access-Control-Allow-Origin` at all otherwise — never `*`. The
allow-list is `ALLOWED_ORIGINS` if set, else `SITE_URL`, each reduced to its
origin (scheme + host + port). One origin: set only `SITE_URL`. Both apex and
`www` serving the site: either redirect one to the other (simplest), or set
`ALLOWED_ORIGINS=https://example.com,https://www.example.com` with `SITE_URL`
the one used in email links. Never add Vercel preview URLs to the production
list.

### Before deploying (operator checks in the dashboards)

1. **Supabase API keys:** the functions read the injected `SUPABASE_ANON_KEY`
   and `SUPABASE_SERVICE_ROLE_KEY`. Confirm in the project's API-key settings
   that these keys are available to Edge Functions (i.e. the legacy anon /
   service_role keys have not been disabled).
2. **Razorpay payment capture:** confirm the account captures payments
   automatically. The code never calls Razorpay's capture API; with manual
   capture an authorised-but-uncaptured payment would still pass the checkout
   signature check and be confirmed, then be auto-refunded by Razorpay.
3. **Resend:** sending domain verified (SPF, DKIM, DMARC — §2); API key created.
4. **Site origin:** decide the single canonical origin → `SITE_URL`.
5. Start with **Razorpay test-mode keys** (`rzp_test_…`); switch to live keys
   only after the verification below passes.

### Deploy (CLI, from the repository root)

```
supabase link --project-ref ohyjqxbsgdkzytfnlitf

supabase secrets set RAZORPAY_KEY_ID=rzp_test_… RAZORPAY_KEY_SECRET=… RAZORPAY_WEBHOOK_SECRET=<long random string>
supabase secrets set RESEND_API_KEY=re_… EMAIL_FROM="Tangy Sessions <hello@your-verified-domain>" \
  SITE_URL=https://<canonical origin> CRON_SECRET=<long random string>
supabase secrets list            # names only; confirm all of the above are present

# browser-called: keep the gateway JWT check
supabase functions deploy razorpay-create-order
supabase functions deploy razorpay-verify-payment
supabase functions deploy send-ticket-email
supabase functions deploy send-approval-email
supabase functions deploy admin-invite-user
# server-to-server: they verify a signature / shared secret themselves
supabase functions deploy razorpay-webhook --no-verify-jwt
supabase functions deploy send-notification-emails --no-verify-jwt
```

Generate random values with `openssl rand -hex 32`. If, after deploying, a
**signed-in** call (step V3) is rejected by the gateway with 401 before the
function runs, redeploy the five browser-called functions with
`--no-verify-jwt`: each verifies the caller itself with `auth.getUser()`, so
this does not open them up.

### Razorpay webhook

- URL: `https://ohyjqxbsgdkzytfnlitf.supabase.co/functions/v1/razorpay-webhook`
- Secret: the same value as `RAZORPAY_WEBHOOK_SECRET`.
- Events the code handles — enable these:
  - `payment.captured` and `order.paid` — confirm the booking (`settle_payment`; either one is enough, both are safe together)
  - `payment.failed` — records the failed attempt (`payment_status = failed`) and keeps the pending hold, because Razorpay lets the customer retry on the same order; the hold is released by its normal expiry (`bookings.pending_timeout_minutes`) or replaced by the customer's next checkout
  - `payment.authorized` — status mirror only
  - `refund.processed` — refund mirror for reporting only: each refund (by refund id) is its own event, so several partial refunds on one payment all count; the mirrored total only ever increases
  - `refund.created` — recorded only (a created refund can still fail; amounts change on `refund.processed`)
- Responses: `200` = recorded and processed (or a duplicate of a processed
  event, or a permanent failure already recorded and alerted); `400` = bad
  signature or body; `503` = secret missing; `500` = not recorded, or a
  database step failed — Razorpay retries, and the retry finishes the event.
- Locate the webhook settings in the Razorpay dashboard yourself; the
  repository cannot confirm its current labels. Configure it separately for
  test mode and live mode, with the matching keys.
- After the first deliveries, compare the payload fields the code reads
  (`payload.payment.entity.id / order_id / amount / amount_refunded`,
  `payload.order.entity.id`, `payload.refund.entity.payment_id / amount`)
  with what Razorpay shows for a delivery.

### Notification email scheduler

Follow §2a (secrets above already include `CRON_SECRET` and `SITE_URL`).

### Verify (test mode)

Run `supabase/ops/payments_and_webhooks.readonly.sql` before starting and after
each step; it shows booking / payment states, items needing action and webhook
health without personal data.

- V1 `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://ohyjqxbsgdkzytfnlitf.supabase.co/functions/v1/razorpay-webhook -d '{}'` → `400` (no signature). `503` means `RAZORPAY_WEBHOOK_SECRET` is missing; `401` means it was deployed without `--no-verify-jwt`.
- V2 `curl -s -X OPTIONS -H "Origin: https://<canonical origin>" -D - -o /dev/null https://ohyjqxbsgdkzytfnlitf.supabase.co/functions/v1/razorpay-create-order | grep -i access-control-allow-origin` → your origin.
- V3 On the site, signed in: book a test session → pay with a Razorpay test method → the booking page shows the tickets and QR; the ticket email arrives.
  Check rows 1–2 (`confirmed`, `captured`), 6 (`0`), 8 (events processed, no errors).
- V4 Close the browser tab right after paying (before the confirmation shows) on a second test booking → within a minute the webhook confirms it (rows 1, 8) and queues the ticket email; the next drain run (§2a) sends it (row 6 back to `0`).
- V5 A failed test payment, then a successful retry in the same checkout → one confirmed booking.
- V6 Redeliver a webhook from the Razorpay dashboard, if it offers that → row 8 total unchanged (duplicate ignored).
- V7 Send yourself a notification email (§2a step 6) and an application decision email.
- V8 Only then switch to live keys (`supabase secrets set RAZORPAY_KEY_ID=rzp_live_… RAZORPAY_KEY_SECRET=…`, live-mode webhook with its own secret), make one small real payment, refund it in Razorpay, and record the refund in Admin → Bookings.

The detailed scenario list in §3 (abandoned checkout, wrong amount, late payment, races) can be run in test mode as well.

### Ticket email

Owned by the email queue, not the browser:

1. `settle_payment` confirms the booking and issues the tickets (unchanged).
2. Whichever of `razorpay-webhook` / `razorpay-verify-payment` sees the
   confirmation queues one `email_outbox` row of type `ticket.confirmed` with
   `dedupe_key = ticket.confirmed:<booking id>` (`_shared/ticketEmail.ts`).
   The key is unique, so duplicate webhooks, `order.paid` + `payment.captured`
   and the browser path all end in **one** row. If the webhook cannot queue
   it, it answers 500 and Razorpay's redelivery queues it.
3. `send-notification-emails` (§2a schedule) renders the ticket email with the
   booking QR, sends it to the account email and sets
   `bookings.ticket_email_status`. A provider failure leaves the booking
   confirmed, marks the email `failed` for the admin and retries the row (up to
   5 attempts). A row whose booking was already emailed (admin resend) or is no
   longer confirmed is marked `skipped`.
4. The browser's call to `send-ticket-email` after checkout is then a no-op;
   Admin → Bookings → Resend email (`force`) always sends.

So ticket emails need the §2a drain schedule; until it runs they wait in the
queue (payments check row 6 lists confirmed bookings whose email is not sent).

### Rollback and recovery

- **Stop taking payments at once:** `supabase secrets unset RAZORPAY_KEY_SECRET` (or `RAZORPAY_KEY_ID`). New checkouts answer 503 and release their seats; payments already made still confirm through the webhook, which needs only `RAZORPAY_WEBHOOK_SECRET`. Set the secret again to resume.
- **Bad function release:** check out the previous commit's `supabase/functions/<name>` (and `_shared/`) and deploy that function again with the same flags.
- **Webhook failing:** Razorpay's delivery log shows the HTTP status. `400` = secret mismatch (re-copy it into both places); `503` = secret missing; `401` = redeploy with `--no-verify-jwt`; `500` = the event was not recorded or a database step failed — Razorpay delivers it again by itself, and a redelivery finishes an event that was recorded but not processed (function logs say which step; row 8/10 of the payments check). Payments made meanwhile are still confirmed by the browser's verify call when the customer completes checkout; the rest appear as pending/expired bookings — see "Payment stuck".
- **Payment stuck** (customer charged, booking not confirmed, or `needs_review`): rows 3, 4 and 10 of the payments check. A `needs_review` booking is resolved in Admin → Bookings (reseat, or refund in Razorpay and record it). For a payment the webhook never recorded, compare with Razorpay's payment list; resolving it in the database is a production write and a deliberate operator decision — the same `settle_payment(order_id, payment_id, amount_paise, 'webhook')` the webhook would have run, executed by the project owner.
- **Email:** unset `RESEND_API_KEY` to stop all sending (queued email waits); deactivate the `tangy-email-drain` cron job to pause notifications only.
- **Rotating a secret:** set the new value in both places (Razorpay webhook form ↔ `RAZORPAY_WEBHOOK_SECRET`; scheduler ↔ `CRON_SECRET`), then re-run V1/V2 or §2a step 4.

## 4. Edge Functions

| Function | Purpose | Env vars | Auth | Local result |
| --- | --- | --- | --- | --- |
| `razorpay-create-order` | Validates the booking, creates the pending booking at the server price, creates the Razorpay order | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `SITE_URL`/`ALLOWED_ORIGINS` | user JWT | E2E: validation, pricing, 503 without keys (checkout, groupcheckin suites) |
| `razorpay-verify-payment` | Verifies the checkout signature, calls `settle_payment` | `RAZORPAY_KEY_SECRET` | user JWT, own booking only | syntax + shared crypto unit tests; refuses (503) without the secret; not exercised end to end (no Razorpay checkout locally) |
| `razorpay-webhook` | Source of truth for payments; HMAC-verified, idempotent | `RAZORPAY_WEBHOOK_SECRET` | signature (deploy with `--no-verify-jwt`) | E2E: success / duplicate / failure / forged signature (checkout suite) |
| `send-ticket-email` | Ticket email with the booking QR — admin resend, browser fallback | email vars | user JWT (own booking) or admin | E2E via Mailpit; `scripts/test-ticket-email.mjs` |
| `send-approval-email` | "Application approved" email | email vars, `SITE_URL` | admin JWT | E2E via Mailpit |
| `send-notification-emails` | Drains `email_outbox` | email vars, `CRON_SECRET`, `SITE_URL` | service key or `x-cron-secret` | E2E + `scripts/run-jobs.sh emails` |
| `admin-invite-user` | Creates a console invitation (hashed single-use token, 72 h) and emails the link; the role is applied only when the recipient accepts at `/invitation` | `SITE_URL`, email settings (section 2) | inviter's JWT — `create_account_invitation` checks `roles.manage` (Super Admin / Admin) or `staff.invite` (Staff) in Postgres; no service role key | E2E invitations (invite → email → accept, single use, wrong account, revoke, manager limited to Staff), sweep (staff refused 403) |
| `_shared/*` | email provider, CORS allowlist, HMAC | — | — | `scripts/test-email-config.mjs`, `scripts/test-edge-shared.mjs`; every browser function's CORS answer and every `razorpay-webhook` status path: `scripts/test-edge-functions.mjs` |

CORS: `SITE_URL` (or `ALLOWED_ORIGINS` for several origins) — the request's origin is echoed only when listed, never `*` (§3a). Every browser-called function also checks the caller's JWT. Deno is not installed on this machine: functions were syntax-checked with esbuild and exercised through `supabase functions serve` in the E2E suites.

Deployment (not done yet): step by step in §3a — all seven, `razorpay-webhook` and `send-notification-emails` with `--no-verify-jwt`.

## 5. Media storage

| Bucket | Visibility | Who writes | Notes |
| --- | --- | --- | --- |
| `content-media` | **private** (0029) | content editors (area rights), session editors | files are referenced as `/storage/content-media/<path>` and shown through 1-hour signed URLs; visitors can sign only files used by published content |
| `artist-media` | private | the artist (own folder) | signed URLs; curators review |
| `artist-avatars` | public | the artist (own folder) | profile photos are public by design |
| `event-documents`, `sponsor-assets` | private | per-document audience / the sponsor | signed URLs |

Size/type limits: content-media 50 MB, images + MP4/WebM only (no HTML/SVG).

## 6. Live seat availability

`event_availability_signal` (0029) holds a version number per session that changes whenever seats may have changed; the session page subscribes to it over Supabase Realtime and re-reads `event_availability()`. It carries no booking data. The page also refreshes on focus, after every booking/payment action, and every two minutes. Capacity is still decided only by the server at checkout.

## 7. Waitlist allocation

Setting `waitlist.allocation` (Admin → Settings):
- `strict_order` (default) — released seats go to the head of the queue only; if that party is bigger than what's free, nobody behind them is offered yet (the free seats remain bookable by anyone).
- `first_fit` — offer to the earliest waiting party that fits.
Offers are held for `waitlist.offer_hold_minutes` (default 120).

## 8. Local demo dataset

`scripts/demo-data.sh seed | remove | status` loads `supabase/demo/demo_seed.sql` (operations: bookings, check-ins, partners, threads) and `demo_seed_history.sql` (a fictional archive). Totals: 35 sessions (26 past, 2022–2026, incl. cancelled), 27 artists, 8 programmes, 22 albums / 88 photos, 15 Tangy TV records (published, draft, archived), 21 diary posts, 12 announcements, 8 sponsors, 8 vendors, 6 venue hosts, 15 volunteers, 64 accounts, 40 bookings, 129 tickets, 15 waitlist entries. Local-only (refuses non-localhost URLs); every record is identifiable (`de300000-…` ids, `@demo.tangy.local` emails, "(demo)" venue / partner names, example.com links).

**Artist portal demo** (`demo_seed_artist_portal.sql`): 12 artist applications in every state, 16 booking requests, artist media and availability — see `docs/ARTIST_PORTAL.md`.

**Images.** Fictional people and nights use generated artwork from `public/media/demo/` (monogram portraits, abstract covers marked "DEMO IMAGE"). The real Tangy posters and performer photos in `public/media/artists` and `public/media/gallery` are never attached to fictional artists or sessions — the only real photos in the demo data are two empty-venue shots. Sign in as any demo account; codes arrive in Mailpit (http://127.0.0.1:54324).
