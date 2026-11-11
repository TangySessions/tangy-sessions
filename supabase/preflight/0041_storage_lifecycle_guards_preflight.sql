-- READ-ONLY preflight for 0041_storage_lifecycle_guards.sql — ONE SELECT statement.
-- Reads catalogs and counts rows; changes nothing. Every row must show ok = true.
-- Rows 9 and 10 are informational (always ok): files whose delete/upload rights 0041 narrows.
with
expected_def(ord, key, cmd, roles, permissive, using_expr, check_expr) as (values
  (6, 'sponsor-assets: delete', 'DELETE', 'authenticated', 'PERMISSIVE',
   '((bucket_id = ''sponsor-assets'') AND (((storage.foldername(name))[1] = (auth.uid())) OR has_permission(''entities.manage'')))',
   null),
  (7, 'artist-media: applicant upload', 'INSERT', 'authenticated', 'PERMISSIVE',
   null,
   '((bucket_id = ''artist-media'') AND ((storage.foldername(name))[1] = ''applications'') AND ((storage.foldername(name))[2] = (auth.uid())))'),
  (8, 'artist-media: applicant delete', 'DELETE', 'authenticated', 'PERMISSIVE',
   '((bucket_id = ''artist-media'') AND ((storage.foldername(name))[1] = ''applications'') AND ((storage.foldername(name))[2] = (auth.uid())))',
   null)
),
actual_def as (
  select policyname as key, cmd, array_to_string(roles, ',') as roles, permissive,
         btrim(regexp_replace(regexp_replace(regexp_replace(replace(qual, '"', ''), '\m(public|artists|objects)\.', '', 'g'), '::[A-Za-z_][A-Za-z0-9_.]*(\[\])?', '', 'g'), '\s+', ' ', 'g'), ' ;') as using_expr,
         btrim(regexp_replace(regexp_replace(regexp_replace(replace(with_check, '"', ''), '\m(public|artists|objects)\.', '', 'g'), '::[A-Za-z_][A-Za-z0-9_.]*(\[\])?', '', 'g'), '\s+', ' ', 'g'), ' ;') as check_expr
  from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and policyname in ('sponsor-assets: delete', 'artist-media: applicant upload', 'artist-media: applicant delete')
),
deps(dep, present) as (values
  ('function public.has_permission(text)', to_regprocedure('public.has_permission(text)') is not null),
  ('function auth.uid()', to_regprocedure('auth.uid()') is not null),
  ('function storage.foldername(text)', to_regprocedure('storage.foldername(text)') is not null),
  ('column sponsor_assets.storage_path', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sponsor_assets' and column_name = 'storage_path')),
  ('column sponsor_assets.status', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sponsor_assets' and column_name = 'status')),
  ('column artist_applications.user_id', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'artist_applications' and column_name = 'user_id')),
  ('column artist_applications.status', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'artist_applications' and column_name = 'status')),
  ('bucket sponsor-assets', exists (select 1 from storage.buckets where id = 'sponsor-assets')),
  ('bucket artist-media', exists (select 1 from storage.buckets where id = 'artist-media'))
),
status_values(dep, present) as (values
  ('sponsor_assets.status allows approved, archived',
   exists (select 1 from pg_constraint where conrelid = to_regclass('public.sponsor_assets') and contype = 'c'
             and strpos(pg_get_constraintdef(oid), '''approved''') > 0 and strpos(pg_get_constraintdef(oid), '''archived''') > 0)),
  ('artist_applications.status allows draft, needs_information',
   exists (select 1 from pg_constraint where conrelid = to_regclass('public.artist_applications') and contype = 'c'
             and strpos(pg_get_constraintdef(oid), '''draft''') > 0 and strpos(pg_get_constraintdef(oid), '''needs_information''') > 0))
),
checks(ord, area, check_name, result, expected, ok) as (
  select 1, 'baseline', '0040 applied (guard_artist_self_edit function + artists_guard_self_edit trigger)',
    (to_regprocedure('public.guard_artist_self_edit()') is not null
       and exists (select 1 from pg_trigger where tgname = 'artists_guard_self_edit' and tgrelid = to_regclass('public.artists')))::text,
    'true',
    to_regprocedure('public.guard_artist_self_edit()') is not null
       and exists (select 1 from pg_trigger where tgname = 'artists_guard_self_edit' and tgrelid = to_regclass('public.artists'))
  union all
  select 2, 'baseline', '0041 not yet applied (no has_open_artist_application)',
    (to_regprocedure('public.has_open_artist_application()') is null)::text, 'true',
    to_regprocedure('public.has_open_artist_application()') is null
  union all
  select 3, 'baseline', '0042–0044 not yet applied',
    concat_ws(', ',
      case when strpos(coalesce(pg_get_viewdef(to_regclass('public.public_artists')), ''), 'COALESCE(NULLIF(btrim(') > 0 then '0042' end,
      case when to_regprocedure('public.set_programme_sessions(uuid,uuid[])') is not null then '0043' end,
      case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('join_waitlist', 'offer_waitlist_seats')
                          and strpos(prosrc, 'event_booking_closed(v_event.event_date, v_event.timezone, v_event.status)') > 0) then '0044' end),
    '(empty)',
    strpos(coalesce(pg_get_viewdef(to_regclass('public.public_artists')), ''), 'COALESCE(NULLIF(btrim(') = 0
      and to_regprocedure('public.set_programme_sessions(uuid,uuid[])') is null
      and not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('join_waitlist', 'offer_waitlist_seats')
                        and strpos(prosrc, 'event_booking_closed(v_event.event_date, v_event.timezone, v_event.status)') > 0)
  union all
  select 4, 'dependencies', 'objects 0041 uses exist',
    coalesce((select string_agg(dep, '; ') from deps where not present), '(none missing)'), '(none missing)',
    not exists (select 1 from deps where not present)
  union all
  select 5, 'dependencies', 'status values 0041 tests are allowed',
    coalesce((select string_agg(dep, '; ') from status_values where not present), '(all allowed)'), '(all allowed)',
    not exists (select 1 from status_values where not present)
  union all
  select e.ord, 'drift', e.key || ' policy unchanged since 0036 (normalized; command, roles, permissive, USING, WITH CHECK)',
    case when a.key is null then 'missing'
         when (a.cmd, a.roles, a.permissive, a.using_expr, a.check_expr)
              is not distinct from (e.cmd, e.roles, e.permissive, e.using_expr, e.check_expr) then 'same as 0036'
         else concat_ws('; ', a.cmd, coalesce(a.roles, '-'), coalesce(a.permissive, '-'),
                        'USING ' || coalesce(a.using_expr, '-'), 'WITH CHECK ' || coalesce(a.check_expr, '-')) end,
    'same as 0036',
    a.key is not null
      and (a.cmd, a.roles, a.permissive, a.using_expr, a.check_expr)
          is not distinct from (e.cmd, e.roles, e.permissive, e.using_expr, e.check_expr)
  from expected_def e left join actual_def a on a.key = e.key
  union all
  select 9, 'impact', 'sponsor files tied to approved/archived assets (sponsor can no longer delete; informational)',
    (select count(*) from storage.objects o where o.bucket_id = 'sponsor-assets'
       and exists (select 1 from sponsor_assets sa where sa.storage_path = o.name and sa.status in ('approved', 'archived')))::text,
    'any (0 on an empty database)', true
  union all
  select 10, 'impact', 'artist-media application files of accounts with no open application (owner can no longer add/delete; informational)',
    (select count(*) from storage.objects o where o.bucket_id = 'artist-media' and (storage.foldername(o.name))[1] = 'applications'
       and not exists (select 1 from artist_applications aa where aa.user_id::text = (storage.foldername(o.name))[2]
                         and aa.status in ('draft', 'needs_information')))::text,
    'any (0 on an empty database)', true
)
select ord, area, check_name, result, expected, ok,
       case when bool_and(ok) over () then 'ALL CHECKS PASSED — safe to apply 0041' else 'STOP — at least one check failed' end as verdict
from checks
order by ord;
