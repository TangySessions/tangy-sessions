-- READ-ONLY combined preflight for applying 0037–0044 to a database at 0036.
-- ONE SELECT statement (the Supabase SQL editor shows only the last result,
-- so every check is a row here). It reads catalogs and counts rows; it
-- cannot insert, update, delete, create, alter or drop anything.
--
-- Combines supabase/preflight/0037_…, 0039_… and 0040_… (their checks,
-- without the per-file "previous migration applied" baselines, which only
-- make sense between migrations) and adds:
--   * a dependency check — helper functions the new migrations call exist;
--   * a drift check — the objects 0037–0044 REPLACE are still exactly what
--     0001–0036 created (a hand edit on production would otherwise be
--     overwritten silently): functions by md5 of their source; the
--     public_artists view and the three storage policies 0041 replaces by
--     their full NORMALIZED definition, compared with the text a clean
--     0001–0036 database gives.
--
-- Normalization (formatting-only; it never removes an operator, literal,
-- column, function or parenthesis): double quotes removed; the qualifiers
-- "public.", "artists." and "objects." removed (PostgreSQL prints them or not
-- depending on version and search_path); type casts "::name" removed (the
-- comparisons are unaffected — 'approved' vs 'approved'::application_status);
-- runs of whitespace collapsed to one space (line breaks and indentation
-- differ between versions); surrounding spaces and the trailing ";" trimmed.
-- Letter case and string literals are kept as they are.
-- Every row must show ok = true. Anything false: stop and investigate.
with
expected_src(name, args, md5) as (values
  ('create_pending_booking', 'p_user_id uuid, p_event_id uuid, p_registration_code text, p_attendee_name text, p_attendee_email text, p_attendee_phone text, p_quantity integer, p_amount integer, p_tier text, p_razorpay_order_id text, p_attendee_names text[], p_details jsonb', '4bfab079449f99f28710f26379c43b09'),
  ('seed_event_ticket_type', '', 'fc43c0dff3b36cf6c1485cf647847395'),
  ('sync_artist_application_status', '', '1240035f244057943ac1857bd2588a4b'),
  ('join_waitlist', 'p_event_id uuid, p_quantity integer', 'c266d17ee0cb72ae8842aea2c08de0fe'),
  ('offer_waitlist_seats', 'p_event_id uuid', '3959b59642c26ec444549309a1dd93da')
),
timeout as (select setting_number('bookings.pending_timeout_minutes', 30)::int as mins),
-- The view and the three storage policies 0041/0042 replace, as a clean 0001–0036 database defines them (normalized).
expected_def(ord, key, cmd, roles, permissive, using_expr, check_expr) as (values
  (20, 'view public_artists', 'VIEW', null, null,
   'SELECT id, name, stage_name, genre, subgenre, city, bio, avatar_url, instagram, soundcloud, spotify, youtube, performance_type, applied_at, slug, cover_url, long_bio, country, languages, instruments, genres, years_active, website, highlights FROM artists WHERE (status = ''approved'')',
   null),
  (21, 'sponsor-assets: delete', 'DELETE', 'authenticated', 'PERMISSIVE',
   '((bucket_id = ''sponsor-assets'') AND (((storage.foldername(name))[1] = (auth.uid())) OR has_permission(''entities.manage'')))',
   null),
  (22, 'artist-media: applicant upload', 'INSERT', 'authenticated', 'PERMISSIVE',
   null,
   '((bucket_id = ''artist-media'') AND ((storage.foldername(name))[1] = ''applications'') AND ((storage.foldername(name))[2] = (auth.uid())))'),
  (23, 'artist-media: applicant delete', 'DELETE', 'authenticated', 'PERMISSIVE',
   '((bucket_id = ''artist-media'') AND ((storage.foldername(name))[1] = ''applications'') AND ((storage.foldername(name))[2] = (auth.uid())))',
   null)
),
-- The same objects as this database defines them now (view options must be
-- unset: CREATE OR REPLACE VIEW in 0042 would drop any that were added).
-- (For the view: cmd = its kind, permissive = its options, using_expr = its definition.)
actual_raw(key, cmd, roles, permissive, using_expr, check_expr) as (
  select 'view public_artists', case c.relkind when 'v' then 'VIEW' else 'relkind ' || c.relkind::text end,
         null, array_to_string(c.reloptions, ','), pg_get_viewdef(c.oid), null
  from pg_class c where c.oid = to_regclass('public.public_artists')
  union all
  select policyname, cmd, array_to_string(roles, ','), permissive, qual, with_check
  from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and policyname in ('sponsor-assets: delete', 'artist-media: applicant upload', 'artist-media: applicant delete')
),
actual_def as (
  select key, cmd, roles, permissive,
         btrim(regexp_replace(regexp_replace(regexp_replace(replace(using_expr, '"', ''), '\m(public|artists|objects)\.', '', 'g'), '::[A-Za-z_][A-Za-z0-9_.]*(\[\])?', '', 'g'), '\s+', ' ', 'g'), ' ;') as using_expr,
         btrim(regexp_replace(regexp_replace(regexp_replace(replace(check_expr, '"', ''), '\m(public|artists|objects)\.', '', 'g'), '::[A-Za-z_][A-Za-z0-9_.]*(\[\])?', '', 'g'), '\s+', ' ', 'g'), ' ;') as check_expr
  from actual_raw
),
checks(ord, area, check_name, result, expected, ok) as (
  -- 0. Baseline: exactly 0036, nothing from 0037–0044 yet.
  select 1, 'baseline', '0036 present (artist-documents own-upload policy uses objects.name)',
    exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'artist-documents: own upload' and with_check like '%foldername(objects.name)%')::text,
    'true', exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'artist-documents: own upload' and with_check like '%foldername(objects.name)%')
  union all
  select 2, 'baseline', 'none of 0037–0044 present',
    concat_ws(', ',
      case when to_regclass('public.bookings_one_active_hold') is not null then '0037' end,
      case when to_regprocedure('public.event_booking_closed(date,text,text,timestamptz)') is not null then '0038' end,
      case when to_regprocedure('public.enforce_ticket_type_price()') is not null then '0039' end,
      case when to_regprocedure('public.guard_artist_self_edit()') is not null then '0040' end,
      case when to_regprocedure('public.has_open_artist_application()') is not null then '0041' end,
      case when exists (select 1 from actual_def where key = 'view public_artists'
                          and strpos(using_expr, 'COALESCE(NULLIF(btrim(stage_name), ''''), name) AS name') > 0) then '0042' end,
      case when to_regprocedure('public.set_programme_sessions(uuid,uuid[])') is not null then '0043' end,
      case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('join_waitlist', 'offer_waitlist_seats')
                          and strpos(prosrc, 'event_booking_closed(v_event.event_date, v_event.timezone, v_event.status)') > 0) then '0044' end),
    '(empty)',
    to_regclass('public.bookings_one_active_hold') is null
      and to_regprocedure('public.event_booking_closed(date,text,text,timestamptz)') is null
      and to_regprocedure('public.enforce_ticket_type_price()') is null
      and to_regprocedure('public.guard_artist_self_edit()') is null
      and to_regprocedure('public.has_open_artist_application()') is null
      and not exists (select 1 from actual_def where key = 'view public_artists'
                        and strpos(using_expr, 'COALESCE(NULLIF(btrim(stage_name), ''''), name) AS name') > 0)
      and to_regprocedure('public.set_programme_sessions(uuid,uuid[])') is null
      and not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('join_waitlist', 'offer_waitlist_seats')
                        and strpos(prosrc, 'event_booking_closed(v_event.event_date, v_event.timezone, v_event.status)') > 0)
  union all
  -- 1. Dependencies the new migrations call.
  select 3, 'dependencies', 'helper functions present',
    coalesce((select string_agg(f, ', ' order by f) from unnest(array['expire_stale_bookings','setting_number','has_permission','is_admin','content_can',
      'waitlist_held_seats','audit_write','notify','booking_quote','valid_attendee_names','booking_answers_error','is_assigned_to_event']) f
      where not exists (select 1 from pg_proc where proname = f and pronamespace = 'public'::regnamespace)), '(none missing)'),
    '(none missing)',
    not exists (select 1 from unnest(array['expire_stale_bookings','setting_number','has_permission','is_admin','content_can',
      'waitlist_held_seats','audit_write','notify','booking_quote','valid_attendee_names','booking_answers_error','is_assigned_to_event']) f
      where not exists (select 1 from pg_proc where proname = f and pronamespace = 'public'::regnamespace))
  union all
  -- 2. 0037 BLOCKING: an account with more than one ACTIVE pending hold for a session would stop 0037.
  select 4, '0037', 'accounts with >1 active pending hold per session (BLOCKING)',
    (select count(*) from (select user_id, event_id from bookings, timeout
       where status = 'pending' and user_id is not null
         and (razorpay_payment_id is not null or created_at >= now() - make_interval(mins => timeout.mins))
       group by user_id, event_id having count(*) > 1) d)::text,
    '0',
    not exists (select 1 from bookings, timeout
       where status = 'pending' and user_id is not null
         and (razorpay_payment_id is not null or created_at >= now() - make_interval(mins => timeout.mins))
       group by user_id, event_id having count(*) > 1)
  union all
  select 5, '0037', 'stale unpaid holds 0037 will expire (normal sweep; informational)',
    (select count(*) from bookings, timeout where status = 'pending' and razorpay_payment_id is null
       and coalesce(source, 'checkout') <> 'complimentary' and created_at < now() - make_interval(mins => timeout.mins))::text,
    'any (0 on an empty database)', true
  union all
  select 6, '0037', 'hold throttle settings already present (0037 keeps existing values)',
    coalesce((select string_agg(key || '=' || (value #>> '{}'), ', ' order by key) from system_settings
      where key in ('bookings.hold_rate_limit', 'bookings.hold_rate_window_minutes')), '(not present — 0037 adds 6 / 10)'),
    '(not present — 0037 adds 6 / 10)', true
  union all
  -- 3. 0039: ticket types on sale at ₹0 (unbuyable; 0039 leaves them as they are).
  select 7, '0039', 'ticket types ON SALE at ₹0',
    (select count(*) from event_ticket_types where price < 1 and active)::text, '0',
    not exists (select 1 from event_ticket_types where price < 1 and active)
  union all
  select 8, '0039', 'ticket types at ₹0 already off sale (informational)',
    (select count(*) from event_ticket_types where price < 1 and not active)::text, 'any', true
  union all
  -- 4. 0040: review records that already look inconsistent (0040 changes no rows; a person checks these).
  select 9, '0040', 'pending artists with review data',
    (select count(*) from artists where status = 'pending' and (reviewed_by is not null or reviewed_at is not null or decision_reason is not null))::text, '0',
    not exists (select 1 from artists where status = 'pending' and (reviewed_by is not null or reviewed_at is not null or decision_reason is not null))
  union all
  select 10, '0040', 'decided artists reviewed by themselves / a non-console role',
    (select count(*) from artists a left join profiles p on p.id = a.reviewed_by where a.status in ('approved', 'rejected') and a.reviewed_by is not null
       and (a.reviewed_by = a.user_id or p.role is null or p.role not in ('admin', 'super_admin', 'staff')))::text, '0',
    not exists (select 1 from artists a left join profiles p on p.id = a.reviewed_by where a.status in ('approved', 'rejected') and a.reviewed_by is not null
       and (a.reviewed_by = a.user_id or p.role is null or p.role not in ('admin', 'super_admin', 'staff')))
  union all
  select 11, '0040', 'impossible review timelines',
    (select count(*) from artists where (reviewed_at is not null and reviewed_at < applied_at) or applied_at > now() + interval '5 minutes')::text, '0',
    not exists (select 1 from artists where (reviewed_at is not null and reviewed_at < applied_at) or applied_at > now() + interval '5 minutes')
  union all
  select 12, '0040', 'internal review notes written by the artist themself',
    (select count(*) from application_reviews r join artists a on a.id = r.source_id
       where r.source_table = 'artists' and r.updated_by is not null and r.updated_by = a.user_id)::text, '0',
    not exists (select 1 from application_reviews r join artists a on a.id = r.source_id
       where r.source_table = 'artists' and r.updated_by is not null and r.updated_by = a.user_id)
  union all
  -- 5. Drift: objects 0037–0044 replace must be exactly as 0001–0036 created them.
  select 13 + (row_number() over (order by e.name))::int, 'drift', 'function ' || e.name || ' unchanged since 0036',
    coalesce((select count(*)::text || ' definition(s), md5 ' || string_agg(md5(p.prosrc), ',') from pg_proc p
      where p.proname = e.name and p.pronamespace = 'public'::regnamespace), 'missing'),
    '1 definition(s), md5 ' || e.md5,
    (select count(*) = 1 and bool_and(md5(p.prosrc) = e.md5 and pg_get_function_identity_arguments(p.oid) = e.args)
       from pg_proc p where p.proname = e.name and p.pronamespace = 'public'::regnamespace)
  from expected_src e
  union all
  select 19, 'drift', 'view public_artists columns (0042 keeps the same columns)',
    (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'public_artists'),
    'id,name,stage_name,genre,subgenre,city,bio,avatar_url,instagram,soundcloud,spotify,youtube,performance_type,applied_at,slug,cover_url,long_bio,country,languages,instruments,genres,years_active,website,highlights',
    (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'public_artists')
      = 'id,name,stage_name,genre,subgenre,city,bio,avatar_url,instagram,soundcloud,spotify,youtube,performance_type,applied_at,slug,cover_url,long_bio,country,languages,instruments,genres,years_active,website,highlights'
  union all
  -- The view (0042) and the three storage policies (0041), compared in full:
  -- kind/command, roles, permissive, USING and WITH CHECK, all normalized.
  select e.ord, 'drift',
    e.key || case when e.cmd = 'VIEW' then ' definition unchanged since 0036 (normalized; no view options)'
                  else ' policy unchanged since 0036 (normalized; command, roles, permissive, USING, WITH CHECK)' end,
    case when a.key is null then 'missing'
         when (a.cmd, a.roles, a.permissive, a.using_expr, a.check_expr)
              is not distinct from (e.cmd, e.roles, e.permissive, e.using_expr, e.check_expr) then 'same as 0036'
         when e.cmd = 'VIEW' then concat_ws('; ', a.cmd, 'options ' || coalesce(a.permissive, '-'), 'definition ' || coalesce(a.using_expr, '-'))
         else concat_ws('; ', a.cmd, coalesce(a.roles, '-'), coalesce(a.permissive, '-'),
                        'USING ' || coalesce(a.using_expr, '-'), 'WITH CHECK ' || coalesce(a.check_expr, '-')) end,
    'same as 0036',
    a.key is not null
      and (a.cmd, a.roles, a.permissive, a.using_expr, a.check_expr)
          is not distinct from (e.cmd, e.roles, e.permissive, e.using_expr, e.check_expr)
  from expected_def e left join actual_def a on a.key = e.key
)
select ord, area, check_name, result, expected, ok,
       case when bool_and(ok) over () then 'ALL CHECKS PASSED — safe to proceed to 0037' else 'STOP — at least one check failed' end as verdict
from checks
order by ord;
