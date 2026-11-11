# Tangy Sessions — Supabase setup

## 1. Apply the migrations

In the Supabase dashboard SQL editor (`https://supabase.com/dashboard/project/<ref>/sql/new`),
run these files **in order**, each as its own query:

1. `migrations/0001_schema.sql` — tables
2. `migrations/0002_rls.sql` — row-level security policies (authorization is enforced here, not just in the frontend)
3. `migrations/0003_role_security.sql` — closes two privilege-escalation gaps left open by 0002 (a signed-in user could otherwise PATCH their own `profiles.role` or `artists.status` directly)
4. `migrations/0004_seed_events.sql` — seeds the events table with the site's existing editorial content so Sessions/Archive/Booking/Calendar aren't empty on first load
5. `migrations/0005_extend_roles.sql` — adds vendor/sponsor/volunteer/crew to `user_role`, rounds out `profiles` (avatar_url, bio, organization_name, updated_at), links applications (collaborations/crew_applications/private_enquiries) to an optional `user_id`
6. `migrations/0006_role_profiles.sql` — `vendor_profiles` / `sponsor_profiles` / `volunteer_profiles` / `crew_profiles`, plus self-read policies on the application tables above
7. `migrations/0007_payments.sql` — `bookings.razorpay_signature_verified`, `payment_webhook_events` for idempotent webhook processing
8. `migrations/0008_conversations_and_assignments.sql` — real chat (conversations/messages) and the admin → artist session assignment request workflow
9. `migrations/0009_waitlist_self_read.sql` — lets a signed-in patron see their own waitlist entries
10. `migrations/0010_venue_role.sql` — adds `venue` to `user_role` (own file — a new enum value can't be used in the same transaction that adds it)
11. `migrations/0011_role_portals.sql` — real crew/volunteer/vendor/sponsor/venue portal backend: `venue_profiles`, `events.venue_partner_id`, `event_assignments` + `event_tasks` (shared by crew/volunteer/vendor event staffing), `sponsor_deliverables`, a `category` column on `crew_applications` distinguishing crew from volunteer, and the `approve_crew_application`/`approve_collaboration` RPCs that provision a role + profile row atomically on admin approval
12. `migrations/0012_artist_availability.sql` — real self-managed artist availability calendar (`available`/`tentative`/`unavailable`); `booked` is always derived from confirmed performances, never self-settable
13. `migrations/0013_artist_media.sql` — a private `artist-media` Storage bucket plus the `artist_media` metadata table backing real demo-track/photo uploads in the Artist Portal (replaces a previous fully-fake "simulate upload" button), and a public `artist-avatars` bucket for real avatar uploads (replaces a previous `URL.createObjectURL` blob that was being saved straight into `artists.avatar_url`, which only ever worked in the uploading browser's own tab)
14. `migrations/0014_artist_spotify.sql` — `artists.spotify`, matching the existing `instagram`/`soundcloud` columns (the portal's Links tab had a Spotify field with no backing column)
15. `migrations/0015_application_lifecycle.sql` — closes the anonymous-application gap on `collaborations`/`crew_applications` (insert now requires `auth.uid() = user_id`; `artists` requires a non-null `user_id` instead, see the file's own note on why), adds `application_notifications` (idempotent approval-email tracking), extends `approve_collaboration`/`approve_crew_application` to queue a notification row, and adds `approve_artist_application`/`reject_artist_application` RPCs (replacing the admin UI's previous direct `.update()` on `artists`)
16. `migrations/0016_payments_tickets_checkin.sql` — closes the fake-confirmed-booking RLS gap (removes client INSERT on `bookings` entirely), adds `create_pending_booking()` (atomic, capacity-checked pending booking creation — the actual overselling protection), a `tickets` table (one row per admission, each with its own random `token` — never a database id or PII — used as the QR credential) plus `confirm_booking_and_issue_tickets()` (idempotent ticket issuance on payment confirmation), moves `checkins` to per-ticket (`checkins.ticket_id`, `unique(ticket_id)`, dropping the old `unique(booking_id)`) with a new `check_in_ticket()` RPC doing full server-side validation atomically, adds `bookings.tier`, the `'failed'` booking status, and `bookings.ticket_email_status/_error/_sent_at` for idempotent ticket-email delivery tracking

## 2. Bootstrap your first admin account

RLS deliberately blocks everyone — including admins — from ever promoting their *own*
account's role (see 0003). That means there is no in-app way to create the first admin;
it has to be done once, directly, by whoever owns the Supabase project:

1. Sign up for a normal account on the live site (via the "LOGIN" button / patron modal, or the `/admin` sign-in form — both create the same kind of account).
2. In the Supabase dashboard → Table Editor → `profiles`, find that row and set `role` to `admin` (or `super_admin`).
3. Sign in at `/admin` with that account from then on.

Use `super_admin` for this first account. Every console account after it joins **by invitation** (0030):
Admin → Users & roles → *Invite team member*. A Super Admin can invite Super Admins, Admin / Managers and
Staff; an Admin / Manager can invite Staff (`staff.invite`). The invitation fixes the role; the recipient
opens the emailed link (`/invitation#token=…`, single-use, 72 hours), signs in with the invited email
address and accepts — only then is the role applied. There is no public screen where anyone picks a
console role, and the database refuses self-promotion (role guard, 0003/0017/0018/0030).

## 2a. Temporary team demo admin

For internal team demonstration, use **one** dedicated Supabase Auth account with `admin` or
`super_admin` — not a shared personal account, and not a fake/mock one. It's provisioned exactly
like any other admin (step 2 above), nothing special:

1. Have one team member sign up for a normal account (patron modal or `/admin` sign-in form).
2. In the Supabase dashboard → Table Editor → `profiles`, set that row's `role` to `admin`.
3. Share the login **credentials out-of-band** (password manager, not chat/email/repo).

**Credentials are intentionally not stored in this repository** — not in source, not in
migrations, not in `.env.local`/`VITE_*` vars, not in commit messages, not here. The account is a
normal Supabase Auth user; its authorization comes entirely from `profiles.role`, the same as
every other admin. There is nothing hardcoded in the frontend to find or leak.

**Before production**, whoever owns the Supabase project should:

- [ ] Delete or disable the temporary demo account (Supabase dashboard → Authentication → Users)
- [ ] Create real production admin account(s) for the actual team
- [ ] Rotate/retire the demo password if it was ever shared beyond the immediate team
- [ ] Re-verify admin-scoped RLS policies (`is_admin()`/`is_staff_or_admin()` — see 0002/0003/0011)
- [ ] Stand up real audit logging for admin preview/approval actions (not implemented yet — see
      `src/pages/admin/AdminPortalPreview.jsx` and `AdminEntitySelector.jsx`)
- [ ] Re-verify every privileged RPC (`approve_crew_application`, `approve_collaboration`, `approve_artist_application`, etc.)

## 2b. Enable email OTP (required — dashboard setting, not code)

Account creation/login now uses real Supabase Auth email OTP everywhere except `/admin`
(`src/components/auth/EmailOtpAuth.jsx` — `supabase.auth.signInWithOtp()` /
`verifyOtp()`, no custom OTP code anywhere in this repo). For the email Supabase sends to
actually contain a 6-digit code (not a magic-link URL), the project's email template must
include `{{ .Token }}`:

1. Supabase dashboard → **Authentication → Email Templates → Magic Link**.
2. Make sure the body includes `{{ .Token }}` (Supabase's newer default templates already do —
   if this project's template still only has `{{ .ConfirmationURL }}`, add the token, e.g.
   `Your code is {{ .Token }}`).
3. **Authentication → Providers → Email** — confirm "Enable email OTP" / the relevant OTP toggle
   is on for the project (naming varies by Supabase Auth UI version).

Without this, `verifyOtp({ token, type: 'email' })` will fail for anyone who never had a code to
type in. This could not be verified against a live project in this environment — treat it as an
explicit deployment checklist item, not something already confirmed working.

## 3. Environment variables

Copy `.env.example` to `.env.local` and fill in:

- `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` (or the legacy `VITE_SUPABASE_ANON_KEY`) — the only variables the browser build needs (`vite build` fails without them).
- `VITE_RAZORPAY_KEY_ID` — not read by the app: `razorpay-create-order` returns the public key id with each order. Every Razorpay, email and cron secret is an Edge Function secret — exact names and the production deployment runbook: `docs/OPERATIONS.md` §3a.

## 4. Deploy the Razorpay Edge Functions

Real payment capture now has a working implementation — three Edge Functions under `supabase/functions/`:

- `razorpay-create-order` — verifies the caller's real Supabase session, computes the authoritative amount from the event's DB price + ticket tier (never trusts a client-sent amount), creates the Razorpay order, and inserts a `bookings` row as `pending`.
- `razorpay-verify-payment` — verifies the Razorpay HMAC signature server-side before flipping a booking to `confirmed`.
- `razorpay-webhook` — Razorpay calls this directly; it's the source of truth regardless of whether the client-side verify call ever completes, and is idempotent via `payment_webhook_events`.

Deploy and configure:

```
supabase functions deploy razorpay-create-order
supabase functions deploy razorpay-verify-payment
supabase functions deploy razorpay-webhook --no-verify-jwt   # Razorpay calls this with no Supabase auth header
supabase secrets set RAZORPAY_KEY_ID=rzp_test_xxx RAZORPAY_KEY_SECRET=xxx RAZORPAY_WEBHOOK_SECRET=xxx
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — don't set those yourself.

In the Razorpay dashboard (Settings → Webhooks), add the `razorpay-webhook` function's URL, subscribe to at least `payment.captured` and `order.paid`, and set a webhook secret matching `RAZORPAY_WEBHOOK_SECRET` above. **Before going live**, confirm the webhook payload's event-id field and event names against Razorpay's current webhook reference in the dashboard's "recent deliveries" panel — noted as a TODO in `razorpay-webhook/index.ts` since it couldn't be verified against live docs while writing this.

This payment flow requires a real signed-in Supabase session — the Edge Functions verify the caller's JWT, and there is no other checkout path.

## 5. Deploy the approval-email Edge Function

Automatic "your application is approved" emails — one Edge Function:

- `send-approval-email` — re-verifies the caller is a real admin, re-fetches the application and the applicant's *authenticated account* email (never the applicant-typed email on the application row), and sends via Resend. Never sends twice for the same application unless explicitly told to (`force: true`, the admin "RESEND EMAIL" action) — see `application_notifications` in `0015_application_lifecycle.sql`.

Deploy and configure:

```
supabase functions deploy send-approval-email
supabase secrets set RESEND_API_KEY=re_xxx SITE_URL=https://tangysessions.com
# optional — defaults to "Tangy Sessions <hello@tangysessions.com>"
supabase secrets set RESEND_FROM_EMAIL="Tangy Sessions <hello@tangysessions.com>"
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically. `RESEND_API_KEY` must be a real Resend API key with a verified sending domain — until both are set, the function fails closed (records the notification as `failed` with "Email service not configured", the application's approval itself is unaffected) rather than silently pretending to send.

This has been **code-reviewed and build-tested, not live-tested** — no Resend account/API key was available in this environment. Before relying on it in production: trigger one real approval end-to-end and confirm the email actually arrives, renders correctly in at least Gmail + Apple Mail, and that the portal link works.

## 6. Deploy the updated Razorpay functions + the new ticket email function

`razorpay-create-order`, `razorpay-verify-payment`, and `razorpay-webhook` all changed in this
pass (capacity-safe booking creation, ticket issuance, `payment.failed` handling) — redeploy all
three, plus the new `send-ticket-email`:

```
supabase functions deploy razorpay-create-order
supabase functions deploy razorpay-verify-payment
supabase functions deploy razorpay-webhook --no-verify-jwt
supabase functions deploy send-ticket-email
```

`send-ticket-email` needs the same `RESEND_API_KEY` (and optional `RESEND_FROM_EMAIL`) secrets as
`send-approval-email` — see that function's own section above; if already set, nothing further is
needed. It additionally imports `qrcode` from esm.sh to render each ticket's QR server-side for
the email attachment — **this import was not live-tested** (no Deno runtime available in this
environment); verify a real send renders/attaches correctly before relying on it.

**Before going live**, double check in the Supabase dashboard (Table Editor → `checkins` →
constraints) that the old `unique(booking_id)` constraint this migration tries to drop
(`checkins_booking_id_key`) is actually gone and `unique(ticket_id)` is in its place — the
`drop constraint if exists` in 0016 assumes Postgres's default auto-generated name for that
original unnamed constraint, which wasn't verified against a live database.
17. `migrations/0017_admin_system.sql` — role-based admin system: `role_permissions` (Super Admin / Admin / Staff permission matrix, `has_permission()` / `my_permissions()`), append-only `audit_logs`, event-scoped staff access (fixes staff previously having global access), `venues`, `announcements`, `system_settings`, admin booking/refund/ticket RPCs, `check_in_ticket()` event authorization, and dashboard/report RPCs. Reverse: `rollbacks/0017_admin_system.down.sql`.
18. `migrations/0018_operations_platform.sql` — operations platform: partner portal data (`event_member_kind()`, `my_portal_events()`, private `event_artist_details`, `event_requirements`, link-based `event_documents`, partner/volunteer announcement audiences — and closes the old `audience <> 'staff'` public-read policy), central `notifications` with triggers, partner ↔ admin messaging (`start_partner_conversation` / `send_message` / inboxes; no user-to-user messaging), time-boxed volunteer check-in (`temporary_access`, `access_requests`, grant/revoke/request RPCs; `check_in_ticket()` honours an active grant for that event only), artist approval now activates the `artist` role, event command center, platform analytics, and `set_role_permission()`. Reverse: `rollbacks/0018_operations_platform.down.sql`. **Optional:** with the `pg_cron` extension enabled, 0018 schedules `log_expired_access()` every 5 minutes to write `access.expired` audit rows; access itself ends at `expires_at` regardless.

19. `migrations/0019_platform_enum_values.sql` — adds `'expired'` to `booking_status` and `assignment_status` (own file: a new enum value can't be used in the transaction that adds it). Reverse: `rollbacks/0019_platform_enum_values.down.sql` (a no-op by design — Postgres can't drop an enum value; 0020's rollback moves every row off `'expired'` first).
20. `migrations/0020_platform_finalization.sql` — platform finalization (additive; no historical migration edited, no existing row deleted). Reverse: `rollbacks/0020_platform_finalization.down.sql`. Details in [0019–0022 in detail](#0019-0022-in-detail) below.
21. `migrations/0021_canonical_admin_links.sql` — new notifications and queued emails link to `/admin-portal/...` instead of the legacy `/admin/...`. Reverse: `rollbacks/0021_canonical_admin_links.down.sql`.
22. `migrations/0022_artist_storage_policies.sql` — fixes the artist-media / artist-avatars ownership policies from 0013 (artists could not use their own files). Reverse: `rollbacks/0022_artist_storage_policies.down.sql`.
23. `migrations/0023_named_group_checkin.sql` — named attendees, one booking QR and partial check-in by name. Reverse: `rollbacks/0023_named_group_checkin.down.sql`.
24. `migrations/0024_event_booking_form.sql` — per-event booking form (tickets per booking, optional questions) and validated booking details. Reverse: `rollbacks/0024_event_booking_form.down.sql`.
25. `migrations/0025_enquiries_auth_first.sql` — enquiries and applications require a signed-in account, duplicate guard, receipts and team alerts; message emails carry no message text. Reverse: `rollbacks/0025_enquiries_auth_first.down.sql`.
26. `migrations/0026_ticket_types_and_settlement.sql` — per-event ticket types priced on the server (`booking_quote`), public availability, and safe payment settlement (`settle_payment`). Reverse: `rollbacks/0026_ticket_types_and_settlement.down.sql`.
27. `migrations/0027_waitlist.sql` — server-authoritative waitlist with held seat offers. Reverse: `rollbacks/0027_waitlist.down.sql`.
28. `migrations/0028_content_cms.sql` — Tangy TV, diary, gallery, artist slugs, session copy editing and granular content permissions. Reverse: `rollbacks/0028_content_cms.down.sql`.
29. `migrations/0029_private_media_realtime_jobs.sql` — private content media with signed URLs, live seat-availability signal, waitlist allocation policy, upload limits on every bucket, single-flight scheduled jobs with a run log. Reverse: `rollbacks/0029_private_media_realtime_jobs.down.sql`.

Database tests live in `tests/` (`admin_system`, `operations_platform`, `platform_finalization`, `canonical_links`, `artist_storage`, `named_group_checkin`, `booking_form`, `enquiries_auth`, `pricing_settlement`, `waitlist`, `content_cms`, `messaging_security`, `media_realtime_jobs`, `invitations_volunteer`, `programmes`, `artist_portal`, `artist_documents_storage`, `ticket_email_outbox`, `pending_holds`, `past_event_booking`, `ticket_price_minimum`, `artist_self_edit`, `staff_ticket_resend_scope`, `payment_retry`, `storage_lifecycle`, `public_artist_privacy`, `consistent_multistep`, `waitlist_local_date`, `public_artists_read_only`) and run against a **local** stack with `scripts/test-db.sh` — each file is one transaction that rolls back. Never run them against production.

### Production application order (0017 → 0045)

**Production status (2026-10-06, PostgreSQL 17.6):** all of 0017–0045 are applied to production. 0037–0045 were applied by hand in the SQL editor, each only after its read-only preflight (`preflight/`) passed and each confirmed by its post-check; production's order was 0037 → 0042, then 0045, then 0043 → 0044 (0045 depends only on the 0042 view). For any new environment, apply in order, each file as its own query, after taking a database backup:

1. `0017_admin_system.sql` → 2. `0018_operations_platform.sql` → 3. `0019_platform_enum_values.sql` (must be committed before 0020 runs) → 4. `0020_platform_finalization.sql` → 5. `0021_canonical_admin_links.sql` → 6. `0022_artist_storage_policies.sql` → 7. `0023_named_group_checkin.sql` → 8. `0024_event_booking_form.sql` → 9. `0025_enquiries_auth_first.sql` → 10. `0026_ticket_types_and_settlement.sql` → 11. `0027_waitlist.sql` → 12. `0028_content_cms.sql` → 13. `0029_private_media_realtime_jobs.sql` → 14. `0030_invitations_and_volunteer_access.sql` (then redeploy `admin-invite-user`) → 15. `0031_programmes_and_history.sql` → 16. `0032_booking_request_states.sql` (must be committed before 0033 runs) → 17. `0033_artist_portal.sql` → 18. `0034_event_artist_workflow.sql` (see `docs/EVENT_WORKFLOW.md`) → 19. `0035_phase1_security_gaps.sql` (run `preflight/0035_phase1_security_gaps_preflight.sql` first — see the 0035 notes below) → 20. `0036_fix_artist_documents_storage.sql` (already applied to production by hand — see the 0036 notes below) → 21. `0037_one_pending_hold_per_account.sql` (run `preflight/0037_one_pending_hold_per_account_preflight.sql` first; redeploy `razorpay-create-order` with it — see the 0037 notes below) → 22. `0038_no_booking_after_event_date.sql` (see the 0038 notes below) → 23. `0039_no_zero_price_ticket_types.sql` (run `preflight/0039_no_zero_price_ticket_types_preflight.sql` first — see the 0039 notes below) → 24. `0040_artist_self_edit_guard.sql` (run `preflight/0040_artist_self_edit_guard_preflight.sql` first — see the 0040 notes below) → 25. `0041_storage_lifecycle_guards.sql` (run `preflight/0041_storage_lifecycle_guards_preflight.sql` first) → 26. `0042_public_artist_display_name.sql` (`preflight/0042_public_artist_display_name_preflight.sql` first, `…_postcheck.sql` after) → 27. `0043_atomic_programme_sessions.sql` (`preflight/0043_atomic_programme_sessions_preflight.sql` first, `…_postcheck.sql` after; deploy the console with it) → 28. `0044_waitlist_event_local_date.sql` (`preflight/0044_waitlist_event_local_date_preflight.sql` first, `…_postcheck.sql` after — see the notes below) → 29. `0045_public_artists_read_only.sql` (run `preflight/0045_public_artists_read_only_preflight.sql` first, `preflight/0045_public_artists_read_only_postcheck.sql` after — see the 0045 notes below)

Redeploy `razorpay-create-order` and `send-ticket-email` after 0023/0024 (they send and read the new fields). After 0026 redeploy **all three** Razorpay functions (`razorpay-create-order`, `razorpay-verify-payment`, `razorpay-webhook` — they call `settle_payment()` and price from ticket types; the old functions would still confirm late payments). After 0026–0028 also redeploy `send-ticket-email`, `send-approval-email` and `send-notification-emails` (shared email module, section 7).

Then deploy the Edge Functions and secrets in [section 7](#7-notification-emails-and-scheduled-jobs-0020). Rollbacks run by hand in **reverse** order (`0045` → `0044` → `0043` → `0042` → `0041` → `0040` → `0039` → `0038` → `0037` → `0036` → `0035` → `0034` → `0033` → `0032` → `0031` → `0030` → `0029` → `0028` → `0027` → `0026` → `0025` → `0024` → `0023` → `0022` → `0021` → `0020` → `0019` → …), each only after the one above it.

### 0019–0033 in detail

**0020 — platform finalization**

- **Schema / features**: `system_settings` for checkout hold, reminder lead time and booking-request deadline; `events.timezone` and `events.doors_at`; private `artist_private_profiles` (phone, rider, hospitality — never public) and admin-only `artist_admin_notes`; server-computed `artist_profile_completion()`; the `public_artists` view (the public site reads this — it **closes the old public read of artist email**); structured artist logistics on `event_artist_details`; artist media curation (`media_type`, `uploaded → under_review → approved/rejected`, `archived`; the `guard_artist_media` trigger stops artists approving their own media); booking requests with proposed slot, fee offer, deadline and expiry (`create_booking_request`, `respond_to_booking_request`, `my_booking_requests`); requirement priority, close and attachments; document categories, descriptions and expiry; sponsor package, deliverable kinds and `sponsor_assets`; vendor/venue setup, breakdown, loading/venue access and on-site contact; event-scoped volunteer teams and team-targeted announcements; event-level tasks with blocked/urgent states and a completion trail; `partner_invoices` (drafts internal; partners see only their own issued/paid/void rows); conversation priority and assignment; server-side expiry of stale pending checkouts (`expire_stale_bookings`), payment states and late-payment reconciliation (`flag_late_payment`, `record_webhook_failure`); rule-based `event_health()`, `admin_operations_overview()` and `admin_search()`.
- **Notifications**: `notifications.category` / `priority`; per-user `notification_preferences` (in-app and email per category, plus a master email switch) checked server-side by `notify()` — critical notices (cancellations, revoked access, payment failures) are always delivered in-app; `email_outbox` queue with de-duplication (chat: one email per thread per 15 min), drained by the `send-notification-emails` Edge Function; new triggers for schedule, document, booking-request, requirement, media-review, sponsor-asset and invoice events; `notify()` is callable only by `service_role` and SECURITY DEFINER code.
- **Storage** (private buckets, 25 MB limit, served only through short-lived signed URLs — Storage signs a URL only for callers passing the bucket's SELECT policy):
  - `event-documents` — `events/<event_id>/...` written by `events.manage` holders; `requirements/<requirement_id>/...` written by the requirement's recipient while it's open. Read = `can_read_event_file()`: the same audience rules as the `event_documents` row (one person / everyone on the event / one member kind), honouring `expires_at`.
  - `sponsor-assets` — `<sponsor_user_id>/...`; a sponsor uploads and reads only their own folder; `entities.manage` holders review.
  - `artist-media` — adds a curator read policy (`entities.manage`) so curators can preview.
- **Scheduled jobs**: `run_platform_jobs()` (service_role only) expires stale checkouts and unanswered booking requests, sends event reminders, overdue-task and expiring-access notices, and logs expired access. If `pg_cron` is available 0020 schedules it every 5 minutes as `tangy-platform-jobs`; otherwise schedule `select public.run_platform_jobs()` externally. Every job is idempotent.
- **Rollback**: `rollbacks/0020_platform_finalization.down.sql` restores every function/policy 0020 replaced to its 0011/0016/0018 definition and **drops** 0020's tables (private artist profiles, admin notes, sponsor assets, partner invoices, notification preferences, email outbox, reminder log — export them first if needed). Rows that only exist because of 0020 are adjusted so older constraints fit (expired bookings/requests → cancelled, closed requirements → accepted, blocked tasks → pending, urgent → high, event-level tasks and storage-backed documents deleted, media statuses mapped back). The `event-documents` and `sponsor-assets` buckets stay (private, with no policies — inaccessible); remove their objects through the Storage API/dashboard before deleting them. Run 0022's and 0021's rollbacks first.

**0021 — canonical console links.** Every in-app notification and queued email goes through `notify()`; 0021 rewrites `/admin`, `/admin/...`, `/admin?...` and `/admin#...` links to `/admin-portal/...` there (helper `canonical_console_link()`), which covers the 0018 generators that still built legacy links (assignment, task, application, message, volunteer access request). Existing rows are **not** rewritten; the app's `/admin/*` → `/admin-portal/*` redirect keeps them working. Rollback restores 0020's `notify()` and drops the helper.

**0022 — artist storage ownership.** 0013's "self" policies on `artist-media` and `artist-avatars` compared the first path segment with `artists.name` (the unqualified `name` inside the subquery resolved to the artist's display name, not the object path), so artists could never upload, preview (sign) or delete their own media or avatar. It failed closed — no one else gained access. 0022 recreates the six policies with `objects.name` qualified (`<artist_id>/<file>`, artist row owned by `auth.uid()`), scoped to `authenticated`, and adds an owner SELECT policy on the **public** avatars bucket so upsert/remove work (no new visibility — avatars are public by design). Admin and curator policies are unchanged. Rollback restores 0013's definitions exactly — i.e. the broken behaviour.

**0023 — named attendees, one booking QR, partial check-in.** The model is extended, not replaced: a booking for N people already had N `tickets` rows (one per admission) and attendance is one `checkins` row per ticket (`unique(ticket_id)`, with who/when). So a ticket *is* an attendee:

- `bookings.attendee_names text[]` — the names typed before payment, one per ticket (`valid_attendee_names`: count = quantity, trimmed, 1–120 chars; duplicates allowed). `confirm_booking_and_issue_tickets()` copies name *i* onto ticket *i*; `tickets.attendee_name` is the source of truth afterwards. Tickets issued before 0023 (and complimentary guest-list tickets) have **no** name — the UI shows "Guest N"; no names are invented or backfilled.
- `bookings.group_token` — opaque 40-hex credential (backfilled for every existing booking). QR payload `TANGY:BOOKING:<token>`: no ids, names, email, phone or payment data. Per-ticket QRs (`TANGY:TICKET:<token>`) keep working unchanged.
- `checkins.batch_id` — rows written by one check-in action share it (existing rows: `batch_id = id`, deterministic).
- `check_in_ticket(p_token, p_event_id, p_method, p_notes, p_attendee_ids uuid[], p_preview)` — the single server function for QR and manual. A booking token locks the booking row, checks event / booking status, then locks exactly the selected tickets of **that** booking and admits them all or none: every id must be distinct, belong to the booking (so to the event), not be cancelled and not be checked in. The quantity is derived from the selection; the client never sends a count. `p_preview` returns the named attendee list and state without writing. Results: `ready`, `valid`, `already_checked_in`, `attendee_already_checked_in`, `invalid_selection`, `invalid_attendee`, `wrong_event`, `cancelled`, `payment_not_confirmed`, `not_found`, plus the existing permission results. Execute: `authenticated` only (and the function re-checks `checkin.perform` / a live volunteer grant and event assignment).
- Read models: `attendee_tickets` adds `guest_name`, `group_token` (only for callers who may check in this event, only while someone is pending), and party counts; `get_checkin_history` adds `guest_name`, `batch_id`; `booking_checkin_history(booking)` returns one row per checked-in attendee (who, when, how) for staff on that event and admins.
- `create_pending_booking` gains `p_attendee_names` (validated; raises `INVALID_ATTENDEE_NAMES`).
- Reports need no change — they already count tickets (attendees), not bookings.
- **Rollback** restores 0020's `create_pending_booking`, 0016/0017's issuance, and 0018's check-in function, view and history. It **drops attendee names** (export first); check-ins written by group check-in stay (they are ordinary per-ticket rows). Group QR codes stop working after a rollback; per-ticket QRs keep working.

**0024 — event booking form.**

- `events.booking_min_quantity` / `booking_max_quantity` (default 1–10, max 50) and `events.booking_questions` — optional per-event questions `{ id, type, label, required, help?, options?, min?, max? }` with types `text`, `long_text`, `number` (counts people in the booking, capped at its size — e.g. chair seating), `date`, `single_select`, `multi_select`, `boolean`. Validated by `valid_booking_questions()` (check constraint). The definition is public (it holds no answers); only `events.manage` holders can change it (existing events RLS).
- Bookings: `booking_answers` (validated against the event's questions by `booking_answers_error()` — required, type, options, bounds, no unknown keys), `contact_instagram` (optional, stored without "@"), `customer_note`, `collab_interests` (structured: artist, sponsor, volunteer, event_team, sound_technical, video_photo, editing, graphic_design, other) and `collab_note`. Collaboration interest is a **lead** for the team — it never grants a role.
- `create_pending_booking(…, p_details jsonb)` validates all of it plus the event's quantity range (`INVALID_QUANTITY` / `INVALID_DETAILS: <reason>`); `razorpay-create-order` also validates name, email and Indian mobile numbers and returns the reason to the customer.
- Privacy: answers (including any date of birth or gender an event asks for) live on the booking row — readable by the booker and by admins with booking access (`bookings` RLS), **not** by event staff or the public; `attendee_tickets` never carries them. Previous Tangy attendance is not asked; admins see it derived from booking history.
- `attendee_tickets` adds `payment_status` and `checked_in_by_name` (exports).
- **Rollback** restores 0023's `create_pending_booking` and `attendee_tickets` and **drops** booking answers, Instagram handles, notes, collaboration interests and the per-event form configuration (export first). Bookings, attendees and check-ins are untouched.

**0025 — authentication-first enquiries.** `contact_enquiries` and `private_enquiries` no longer accept anonymous inserts: the caller must be signed in and `user_id = auth.uid()` (`contact_enquiries.user_id` added). Artist applications must be for the caller's own account (was: any `user_id`). `guard_duplicate_application()` (per-user advisory lock) refuses a second *pending* application of the same kind and the same contact message within 24 h (`DUPLICATE_APPLICATION: …`). Applicants get an `application.received` receipt (in-app + email outbox) that says applying never changes their account; private/contact enquiries alert `applications.review` holders (`enquiry.new`, linking to the right inbox). `notify()` allows a user as their own recipient only for receipts, and `message.new` emails say "open it to read" — the message text stays in the app. Choosing a path on the Membership Desk still never grants a role (`prevent_role_self_escalation`, 0003). **Rollback** restores the anonymous policies and 0021/0020's `notify()`/metadata and drops `contact_enquiries.user_id`.

**0026 — ticket types and payment settlement.**

- `event_ticket_types` (per event: code, name, description, price in ₹, optional per-type limit, sort order, on sale). Public read of on-sale types of published events; changes need `events.manage`. Existing events were backfilled with the three former tiers at their old prices (base, +₹500, +₹1,200) so nothing changes for customers until an admin edits them; new events start with General Admission at `events.price`, and `events.price` follows the cheapest on-sale type.
- `booking_quote(event, type, quantity)` — the only price calculation (subtotal + `bookings.tax_percent`, default 18). `event_availability(event)` — seats left (counts only) and per-type remaining. Both callable by anyone.
- `create_pending_booking` (customer path) validates the type and its limit and **charges the quote**; the client amount is ignored. Complimentary/admin paths keep their explicit amount.
- `settle_payment(order, payment, amount_paise, source)` (service role only) is what verify-payment and the webhook call. Same lock order as checkout (event, then booking). Confirms idempotently (`already_confirmed`); accepts a late payment only if the seats are still free (`payment.late_accepted` audit); otherwise — amount mismatch, cancelled booking, or seats gone — records the payment as `needs_review`, audits `payment.needs_review` and alerts `payments.view` holders (`payment.review`). **No automatic refunds** are made: finance refunds in Razorpay or reseats the guest.
- **Rollback** restores 0024's checkout and the late-payment flag trigger, maps `needs_review` back to `captured`, and drops ticket types (bookings keep their `tier` code and amount).

**0027 — waitlist.** `waitlist` gains `user_id`, `quantity`, `status` (`waiting → offered → converted | expired | cancelled | skipped`), offer timestamps, `booking_id` and a strict arrival order (`queue_no`); one live entry per person per session. Only the RPCs write it (the anonymous insert policy is gone): `join_waitlist` (signed in; only when the party doesn't fit or others are already waiting, or the session is marked sold out), `leave_waitlist`, `my_waitlist` (position and offer), `admin_offer_waitlist` / `admin_remove_waitlist_entry` (`bookings.manage`, audited). `offer_waitlist_seats(event)` runs under the event row lock whenever seats free up — a booking leaves pending/confirmed (cancelled, expired checkout, failed, refunded), capacity rises, an offer is declined or lapses — and offers strictly first-come-first-served (a smaller party never jumps the queue), holding the seats for `waitlist.offer_hold_minutes` (default 120) and notifying the person (`waitlist.offer`, in-app + email outbox). Held seats count against capacity in checkout, `event_availability` and late settlement, so two people can never claim the same released seat; the holder's checkout converts the offer. `expire_waitlist_offers()` runs in `run_platform_jobs()`. Pre-0027 anonymous rows are listed for the team but never auto-offered. **Rollback** restores 0026's functions and 0020's jobs, the anonymous insert policy, and drops the offer/queue columns.

**0028 — content CMS.** `tv_videos`, `diary_posts`, `gallery_albums` / `gallery_photos` with `draft / published / archived` and scheduled publishing (`published_at`); visitors read published items only. Validation: url-safe unique slugs, media links must be site paths or `https://` (no `http:`/`javascript:`), photo alt text required. Permissions: `content.view / create / edit / publish / delete` combined with an area (`content.manage_tv / manage_diary / manage_media`); publishing or unpublishing needs `content.publish` (trigger — also enforced for direct API writes); `content.manage_sessions` + `content.edit` may edit a session's public copy through `update_session_content()` (description, story, image, tags, featured — never price, capacity or dates). Admin and super admin get all of them; grant others on the Roles page. Changes are audited. `content-media` bucket: public read, 50 MB, images/MP4/WebM only, writes need a content area right. `artists.slug` (unique, from stage name) and `public_artists.slug` power `/artists/:slug`. Seeds: the bundled TV videos and gallery photos (published); the old static diary copy is imported as **drafts** to review. **Rollback** drops the content tables (export first), the slug and the permissions; the bucket remains (Storage blocks SQL deletes).

**0029 — private media, live availability, allocation policy, upload limits, job runs.**

- `content-media` becomes a **private** bucket. Uploads are stored as `/storage/content-media/<path>` and shown through one-hour signed URLs; `content_media_is_public(name)` lets Storage sign a file for anyone only while it belongs to published content (published TV video / diary post / album / photo with `published_at` in the past, or a non-draft session cover). Editors see drafts. Existing references to bundled `/media/...` files are unaffected.
- `event_availability_signal` (in the `supabase_realtime` publication; public read for non-draft sessions; no booking data) is bumped by triggers on bookings, waitlist, ticket types and event capacity/status. The session page re-reads `event_availability()` when it changes.
- `waitlist.allocation` setting: `strict_order` (default, unchanged) or `first_fit`; `offer_waitlist_seats` records the policy in each `waitlist.offered` audit.
- Size limits and MIME allowlists on every bucket; the public `artist-avatars` bucket takes raster images only (no HTML, no SVG).
- `run_platform_jobs(source)` takes a transaction advisory lock (an overlapping run is skipped and recorded) and logs each run in `platform_job_runs`.
- Tests: `tests/media_realtime_jobs.test.sql`; two-session races in `scripts/test-concurrency.sh`. **Rollback** makes content-media public again, restores 0027's offer engine and jobs function, removes the signal, the run log and the upload limits.

**0030 — account invitations and event-scoped volunteer access.**

- `account_invitations`: invited email, intended role (`super_admin` / `admin` / `staff`), inviter, created / expires (72 h) / accepted / revoked timestamps, email delivery status, and the **SHA-256 hash** of a 32-byte random token (the raw token exists only in the emailed link's URL fragment). One open invitation per email; a new one replaces the old. No table access for anyone — only RPCs: `create_account_invitation` (called by `admin-invite-user` under the inviter's JWT; Super Admin / Admin invitations need `roles.manage`, Staff invitations need `staff.invite` or `users.manage`), `list_account_invitations`, `revoke_account_invitation`, `invitation_preview` (what `/invitation` shows), `accept_account_invitation` (signed in as the invited address; refuses expired, used, revoked, wrong-account and deactivated cases). The role guard allows exactly one self role change: the one made in the same transaction that accepted a matching invitation. All of it is audited (`user.invited`, `user.invitation_revoked`, `user.invitation_accepted`).
- `admin-invite-user` no longer creates the auth user or sets the role; it creates the invitation and emails the link. If email isn't configured or fails, the console says so and shows the link once for manual delivery — it never reports a send that didn't happen. It no longer uses the service role key.
- Security fixes: `is_assigned_to_event()` counts **staff** assignments only (a volunteer/crew place no longer gives staff access to that session, and partners can't call admin RPCs such as `event_health`); new `crew_applications` rows from end users always start `pending` (a self-submitted "approved" row used to unlock the volunteer portal UI).
- Volunteer applications may name a session (`crew_applications.event_id`; open sessions only, one pending application per session). Approval adds a `volunteer` place on that session's team; members become Volunteers, staff keep their role. Staff must name a session. Volunteer access never adds console permissions.
- Tests: `tests/invitations_volunteer.test.sql`, `e2e/invitations.mjs`. **Rollback** drops the invitations (accepted roles stay), the session column and the new checks, and restores 0018's role guard and assignment check, 0017's staff scoping and approval, and 0025's duplicate guard.

**0031 — programmes and session history.** `programmes` (title, slug, year, season, description, venue, cover, draft / published / archived with scheduled `published_at`) and `programme_events` (which sessions belong to it, in order). Same content rules as 0028: visitors read published programmes only, publishing needs `content.publish`, editing needs `content.*` + `content.manage_sessions` (Admin → Content → Programmes), every change audited. `events.attendance_recorded` holds the head count for past sessions held before online ticketing (shown on `/sessions/archive/:slug` only when set). Tests: `tests/programmes.test.sql`, `e2e/archive.mjs`. **Rollback** drops both tables and the column.

**0032 / 0033 — artist portal and applications.** See `docs/ARTIST_PORTAL.md`. Security fixes: internal review notes move from applicant-readable rows (artists, collaborations, crew_applications) to `application_reviews` (a trigger keeps the existing approve functions working); artist availability is no longer publicly readable. New: `artist_applications` (multi-step drafts, review cycle via `review_artist_application`), artist profile fields, booking-request details and states (draft / confirmed / completed — enum values in 0032), `artist_schedule_check`, `set_artist_availability`, artist media metadata, `artist_documents` + private `artist-documents` bucket, applicant uploads under `artist-media/applications/<user id>/`. Tests: `tests/artist_portal.test.sql`, `e2e/artist-portal.mjs`. **Rollback**: 0033's down file (export `application_reviews` first); 0032's enum values cannot be dropped — the 0033 rollback maps those requests back to cancelled / accepted.

**0035 — Phase 1 security gaps.** Closes the Phase 1 issues 0017–0034 did not cover, verified against a database built from 0001–0034. Not changed: the booking RPC lockdown (0017), the role guard / Super Admin model (0018/0030), the event-delete guard and the absence of API deletes on bookings/tickets/check-ins, the crew/volunteer insert guard, and private artist availability (0033).
- **Applications start in review:** inserts into `artists`, `collaborations` (vendor / sponsor / venue_host) and `private_enquiries` are stored as `pending` with review fields cleared, `contact_enquiries` as `new` — for API callers (same convention as `guard_crew_application_insert`). Previously an applicant could submit themselves as `approved`.
- **One artist profile per account:** unique `artists.user_id` (the migration stops, changing nothing, if duplicates exist — preflight result 2).
- **Profile identity:** `profiles.email` / `passport_id` / `member_since` / `created_at` can't be changed through the API; the email is copied from `auth.users` when the sign-in email changes. The waitlist email policy (0009) now uses the email in the signed JWT instead of `profiles.email`.
- **Approved artists only on the legacy assignment flow:** `create_assignment_request` / `respond_to_assignment_request` (0008) never checked `artists.status`; a trigger on `assignment_requests` now does (the newer booking-request flow already did).
- **Conversation assignment:** an `admin` participant must be a staff/admin/super_admin account (`assign_conversation` accepted any user id).
- **Function privileges:** trigger functions are no longer executable by API roles; `send_event_reminders`, `notify_overdue_tasks`, `notify_expiring_access`, `event_member_ids`, `partner_kind`, `member_link`, `notification_allowed`, `has_active_access` (no caller check of their own) are service_role only; the implicit `PUBLIC` grant is dropped from every SECURITY DEFINER function while each keeps exactly its current anon/authenticated access.
- No rows are changed; idempotent. Tests: `tests/phase1_security_gaps.test.sql`; safety scenarios (rows unchanged, re-apply, rollback, re-apply after rollback, duplicate stop, wrong-baseline stop): `scripts/test-migration-safety-0035.sh`. **Rollback** restores every function ACL exactly from the snapshot 0035 records (`_security_0035_function_acl`), the 0009 waitlist policy, and drops the triggers and the unique index.

**0036 — artist-documents storage ownership.** Recorded from production, where it was applied by hand after 0035 (the bucket held zero objects). 0033's three "own" policies on the private `artist-documents` bucket used an unqualified `name` inside a subquery over `public.artists`, which resolved to `artists.name` instead of `storage.objects.name` (the same bug 0022 fixed for artist-media / artist-avatars), so no artist could upload, open or delete their own documents. 0036 recreates them with `storage.objects.name`; paths stay `<artist id>/…` (as `src/artist/portal/pages/InboxPages.jsx` uploads them). "artist-documents: team read" is unchanged. No rows are changed; idempotent. Tests: `tests/artist_documents_storage.test.sql`. **Rollback** restores 0033's (broken) definitions exactly.

**0037 — one checkout hold per account per session.** `create_pending_booking` capped tickets per booking but not holds per account, so one signed-in account could call `razorpay-create-order` repeatedly and keep a session looking sold out. Now: a partial unique index `bookings_one_active_hold (user_id, event_id) where status = 'pending' and user_id is not null` (complimentary bookings have no user and are unaffected); each account's calls are serialized by an advisory transaction lock taken before the existing event row lock; the same checkout again (same details) returns the existing hold and its Razorpay order (the Edge Function reuses the order); changed details release the earlier **unpaid** hold (`expired`, audit `booking.superseded`) in the same transaction; a hold with a payment in flight or under review is never released (`HOLD_IN_PROGRESS`, 409); at most `bookings.hold_rate_limit` (6) new holds per `bookings.hold_rate_window_minutes` (10) per account (`RATE_LIMITED`, 429). Everything else in the function is unchanged from 0027. Tests: `tests/pending_holds.test.sql`, `scripts/test-pending-holds-concurrency.sh` (real concurrent connections; `BASELINE=1` shows the problem without 0037), `scripts/test-create-order.mjs`. **Rollback** restores 0027's function exactly, drops the index and the two settings.

**0038 — no booking after a session's date.** Past sessions were refused only in the browser, and nothing moves events to `past` automatically, so a direct `razorpay-create-order` call for an old session still `on-sale` could take payment. `create_pending_booking` now raises `EVENT_CLOSED` (409 from the Edge Function) when `event_booking_closed(event_date, timezone, status)` is true: status `past`, or `event_date` earlier than today **in the event's own timezone** (`events.timezone`, validated IANA name, default Asia/Kolkata — the rule `event_health` already uses). A session is bookable through its whole local day and closes at local midnight, never UTC midnight. Checked right after the event lock, before any hold is resumed, replaced or placed. No data change; no new schedule (bookings no longer depend on the `past` status). Tests: `tests/past_event_booking.test.sql` (fixed-instant boundary cases in IST, UTC+14 and UTC−7; real-clock bookings), `scripts/test-create-order.mjs`. **Rollback** restores 0037's function exactly and drops the helper.

**0039 — no ₹0 ticket types.** `event_ticket_types.price` (whole rupees) allowed 0, but every booking is a Razorpay order and Razorpay cannot take ₹0, so a ₹0 type showed as on sale and could never be bought. There is no free-booking flow (comps go through `admin_create_comp_booking`, which ignores ticket prices). A `BEFORE INSERT OR UPDATE` trigger (`enforce_ticket_type_price`) refuses a new type below ₹1, a change of price to below ₹1, and putting a below-₹1 type back on sale — for every writer (admin editor via RLS, service role, SQL editor) — with SQLSTATE 23514 and a staff-readable message (`hint = 'tangy:user'`). ₹1 is Razorpay's minimum (100 paise). `seed_event_ticket_type()` no longer creates the automatic "General Admission" type for an event inserted without a price (`events.price` defaults to 0); priced events are seeded exactly as before. **No data change:** existing ₹0 types are left as they are (the migration reports how many; the preflight lists them) and can still be renamed, taken off sale, deleted if unsold, or given a price. Positive prices, `booking_quote`, `create_pending_booking`, RLS and the Razorpay functions are unchanged. Tests: `tests/ticket_price_minimum.test.sql`. **Rollback** drops the trigger and function and restores 0026's seed function exactly.

**0040 — artists edit their profile, not Tangy's review record.** "artists: self update own profile" (0002) limits which row an artist may update, not which columns, and 0003 guards only `status`. So an artist could rewrite `reviewed_by`, `reviewed_at`, `applied_at`, `decision_reason`, their public URL (`slug`) or contact `email` — and a `review_notes` write was copied by `move_review_notes()` (0033) into the reviewers-only `application_reviews`. The `artists_guard_self_edit` trigger (`BEFORE INSERT OR UPDATE`, named to fire before `artists_private_notes`) applies only when the signed-in user edits their own row and is not an admin: every column outside the artist-editable allowlist must stay unchanged (42501, staff-readable message naming the fields), so columns added later are protected by default. Editable: `name`, `stage_name`, `bio`, `long_bio`, `genre`, `subgenre`, `genres`, `city`, `country`, `instagram`, `soundcloud`, `spotify`, `youtube`, `website`, `experience_level`, `performance_type`, `years_active`, `performance_count`, `languages`, `instruments`, `highlights`, `notable_venues`, `audience_metrics`, `avatar_url`, `cover_url`. On self-apply (INSERT) `applied_at` is set to now and `slug` is generated. Admins, the review RPCs, `submit_artist_application`, the service role and the SQL editor are unaffected; RLS is unchanged. The public URL is set by Tangy: admins edit it in the artist editor (blank = regenerate from the stage name). No data change; the preflight lists review records that already look inconsistent. Tests: `tests/artist_self_edit.test.sql`. **Rollback** drops the trigger and function.

**0037 / 0038 — failed payment attempts (revised before release).** razorpay-webhook no longer releases a hold on `payment.failed` (Razorpay lets the customer retry on the same order; releasing let the seats be resold before the retry was paid, which put the payment into `needs_review`). It records `payment_status = 'failed'` on the still-pending hold, which expires normally. `create_pending_booking`'s in-flight check therefore treats `payment_status` `created` **or `failed`** as resumable/replaceable ("Try again" resumes the same order); `authorized`, `needs_review` or a recorded payment id still refuse with `HOLD_IN_PROGRESS`. 0037 and 0038 were edited in place for this before either was applied anywhere; that final version is what production received (2026-10-06). Tests: `tests/payment_retry.test.sql`, `scripts/test-webhook-payments.mjs`.

**0041 — storage follows the review lifecycle.** A sponsor may delete a `sponsor-assets` file only while it is not tied to an approved or archived `sponsor_assets` row (unreviewed, changes requested, or no row); curators (`entities.manage`) keep full control; there is still no update/overwrite policy. Applicant uploads and deletes under `artist-media/applications/<uid>/` need the caller's own artist application to be `draft` or `needs_information` (`has_open_artist_application()`); submitted/decided applications are frozen. Reads, the artist folder rules and bucket limits are unchanged. Tests: `tests/storage_lifecycle.test.sql`. **Rollback** restores the 0020/0033 policies and drops the helper.

**0042 — public artist name.** `public_artists.name` is now the public display name (`stage_name`, else the listed name); the legal name stays on `artists` (artist + team only). Same columns, no consumer changes. Tests: `tests/public_artist_privacy.test.sql`. **Rollback** restores 0033's view.

**0043 — consistent multi-step writes.** `set_programme_sessions(programme, event_ids[])` (SECURITY INVOKER — the existing `programme_events` policies decide) replaces a programme's sessions in one transaction; the console uses it instead of delete-then-insert. `sync_artist_application_status` also syncs an application waiting in `needs_information` when the artist row is approved/rejected directly. Tests: `tests/consistent_multistep.test.sql`. **Rollback** drops the function and restores 0033's trigger function (revert the console first).

**0044 — waitlist local date.** `join_waitlist` and `offer_waitlist_seats` close a session's waitlist with `event_booking_closed()` (0038 — the event's own timezone) instead of the UTC `current_date`. Bodies otherwise unchanged. Tests: `tests/waitlist_local_date.test.sql`. **Rollback** restores the 0027/0029 bodies.

**0045 — public artist directory is read-only.** `public_artists` is a simple (automatically updatable) view owned by the owner of `artists`, so the artists RLS policies do not apply through it, and Supabase's default privileges had given `anon` and `authenticated` every privilege on it: anyone with the public key could PATCH or DELETE approved artists through `/rest/v1/public_artists`. 0045 revokes INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on the view from `anon` and `authenticated` (SELECT stays), then checks the effective result in the same transaction and stops, changing nothing, if either role could still write (a grant from another role or to PUBLIC) or lost SELECT. View definition and columns, `service_role` and the owner, the `artists` table and its RLS are unchanged; nothing writes through the view. Depends only on the 0042 view — 0043/0044 may be applied before or after it. No data change. Tests: `tests/public_artists_read_only.test.sql`. **Rollback** re-grants the write privileges (re-opens the hole).

## Local review tools

- `scripts/demo-data.sh seed|remove|status` — the local demo dataset (docs/OPERATIONS.md §8). `scripts/test-db.sh` sets it aside while the suites run and restores it.
- `scripts/test-fresh-db.sh` — every migration on an empty database + every suite.
- `scripts/test-db-local.sh` — the same without Docker: a throwaway local PostgreSQL 16 with `tests/local/supabase_shim.sql` standing in for Supabase's roles, `auth`/`storage`/`extensions` schemas and default privileges. Database enforcement only (no GoTrue, PostgREST, Storage, Realtime, pg_cron or Edge Functions).
- `scripts/test-migration-safety-0035.sh` — 0035's data-safety scenarios on throwaway local databases.
- `scripts/test-concurrency.sh`, `scripts/run-jobs.sh`, `scripts/test-email-config.mjs`, `scripts/test-edge-shared.mjs`.
- `node scripts/route-inventory.mjs` → `docs/ROUTES.md`.

## Messaging security

Classification: **server-side access-controlled messaging, not end-to-end encrypted.** Messages (`messages.content`), thread previews and in-app notifications are stored as plaintext in Postgres, protected in transit by TLS and at rest by the platform's disk encryption; access is enforced by RLS and SECURITY DEFINER RPCs. Participants read their own threads; the Tangy team (`messages.manage`: admin, super admin) reads and replies to partner threads by design — it is a support inbox. Event staff, other partners, patrons and visitors cannot read or post (`tests/messaging_security.test.sql`); nobody can send as someone else, add themselves to a thread, or edit/delete sent messages. Message text never appears in audit logs or notification emails. The app does not claim encryption it doesn't have. True E2EE would need client-side key management (per-device keys, key backup, and a decision that the team can no longer read partner threads) — a product decision, not a patch.

## What's NOT covered by these migrations

- Museum exhibits (vinyl catalogue, sound archive, archive spread, merch previews) are still static decoration in `src/data/mockData.js`; the merch shop is labelled "coming soon" and sells nothing. Diary, gallery, Tangy TV and artist pages are database-backed since 0028.
- Legal pages (terms, privacy, refund policy) are not written — they need the business's own text. `/faq` describes only how the platform behaves.
- **Pending-booking expiry** is handled since 0020 (`expire_stale_bookings()`, run by `run_platform_jobs()` and before every new checkout) — but only if the jobs are actually scheduled (pg_cron or an external scheduler, see 0020 above).
- **Refunds**: 0017 records refunds made in the Razorpay dashboard (`admin_record_refund`); it does not move money through the Razorpay API. The webhook (0020) only mirrors the refunded amount and payment state for reporting.
- **Ticket cancellation**: available to admins since 0017 (`admin_cancel_ticket`).
- **Notification email** needs `send-notification-emails` deployed and scheduled (section 7); until then `email_outbox` rows simply wait and in-app notifications still work.
- **Razorpay**: without `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` checkout answers 503 "Online payment is not available yet" and releases the seats. Live keys, webhook subscription and a real test payment are still to be done before launch.

## 7. Notification emails and scheduled jobs (0020)

`send-notification-emails` drains `email_outbox` (claimed with `FOR UPDATE SKIP LOCKED`, retried up to 5 times, then marked `failed` for admins to see in the email delivery log). It never accepts an end-user session: callers must send either `Authorization: Bearer <service_role key>` or `x-cron-secret: <CRON_SECRET>`.

```
supabase functions deploy send-notification-emails --no-verify-jwt   # it checks the service key / CRON_SECRET itself
supabase secrets set CRON_SECRET=<long random string> SITE_URL=https://tangysessions.com
# RESEND_API_KEY, EMAIL_FROM (or the older RESEND_FROM_EMAIL), optional EMAIL_REPLY_TO — shared by every email function
```

Schedule a `POST` to the function every minute or two (Supabase dashboard → Integrations → Cron → HTTP request, or any external scheduler) with the `x-cron-secret` header. Links in emails are `SITE_URL` + the notification's path. Step-by-step production runbook, with a read-only check (`ops/scheduled_jobs_and_email.readonly.sql`) to run before and after: `docs/OPERATIONS.md` §2a.

All email goes through `functions/_shared/email.ts`. `EMAIL_PROVIDER` is `resend` (default), `log` (development: logs recipient and subject only), `disabled`, or `mailpit` (local stack only, with `MAILPIT_URL`). **Without `RESEND_API_KEY` email is "not configured"**: nothing is sent and nothing crashes — `send-notification-emails` leaves the queue untouched (rows are not marked failed) and ticket/approval emails record "Email is not configured yet." so an admin can resend once it is. The sending domain must be verified in Resend. `node scripts/test-email-config.mjs` checks the provider logic without Deno or network.

`run_platform_jobs()` (expiries, reminders, overdue/expiring notices) is scheduled by 0020 itself when `pg_cron` is available; otherwise call `select public.run_platform_jobs()` every 5 minutes with the service role.

Also redeploy `razorpay-webhook` (changed in this pass: records `payment.authorized`, mirrors `refund.processed`/`refund.created`, stores processing failures on the event via `record_webhook_failure()` and alerts `payments.view` holders instead of only logging them). Subscribe the Razorpay webhook to those events too. As before, confirm payload field names against Razorpay's live "recent deliveries" before going live.
