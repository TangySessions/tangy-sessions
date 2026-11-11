-- READ-ONLY check AFTER applying 0044_waitlist_event_local_date.sql — ONE
-- SELECT statement; it cannot change anything. Every row must show
-- ok = true; the last row is the verdict. Rows 14 and 15 must show exactly
-- what preflight rows 16 and 17 showed (0044 changes no data and nothing
-- besides the bodies of its two functions).
with
fn as (
  select p.oid, p.proname, p.prosrc, p.prosecdef, p.proconfig, p.proowner, p.proacl,
         pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as result
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('join_waitlist', 'offer_waitlist_seats')
),
ebc as (
  select p.oid, p.prosrc from pg_proc p where p.oid = to_regprocedure('public.event_booking_closed(date,text,text,timestamptz)')
),
-- Same fingerprint as preflight row 17: everything except the two functions 0044 replaces.
fp as (
  select md5(string_agg(x, E'\n' order by x)) as h, count(*) as n from (
    select 'fn ' || p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(p.proacl::text, '-') as x
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
        and p.proname not in ('join_waitlist', 'offer_waitlist_seats')
    union all
    select 'rel ' || c.oid::regclass::text || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '-') || ' '
           || coalesce(array_to_string(c.reloptions, ','), '-') || ' ' || c.relrowsecurity::text || c.relforcerowsecurity::text
      from pg_class c where c.relnamespace in ('public'::regnamespace, 'storage'::regnamespace) and c.relkind in ('r', 'v', 'm', 'p', 'S')
    union all
    select 'col ' || c.oid::regclass::text || ' ' || string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' order by a.attnum)
      from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'p') group by c.oid
    union all
    select 'view ' || c.oid::regclass::text || ' ' || md5(pg_get_viewdef(c.oid))
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm')
    union all
    select 'pol ' || schemaname || '.' || tablename || '.' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' '
           || permissive || ' ' || coalesce(qual, '-') || ' ' || coalesce(with_check, '-')
      from pg_policies where schemaname in ('public', 'storage')
    union all
    select 'trg ' || t.tgrelid::regclass::text || '.' || t.tgname || ' ' || t.tgenabled::text || ' ' || md5(pg_get_triggerdef(t.oid))
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relnamespace in ('public'::regnamespace, 'storage'::regnamespace)
    union all
    select 'idx ' || schemaname || '.' || indexname || ' ' || md5(indexdef) from pg_indexes where schemaname in ('public', 'storage')
    union all
    select 'con ' || conrelid::regclass::text || '.' || conname || ' ' || md5(pg_get_constraintdef(oid))
      from pg_constraint where connamespace = 'public'::regnamespace
  ) s
),
checks(ord, area, check_name, result, expected, ok) as (
  select 1, 'functions', 'join_waitlist / offer_waitlist_seats are the 0044 bodies',
    coalesce((select string_agg(proname || ' md5 ' || md5(prosrc), '; ' order by proname) from fn), 'missing'),
    'join_waitlist md5 ece36644ad142413526fb93e25fa2d6a; offer_waitlist_seats md5 a7e4ff44e71af1b41980a54c755f1186',
    coalesce((select string_agg(proname || ' md5 ' || md5(prosrc), '; ' order by proname) from fn), '')
      = 'join_waitlist md5 ece36644ad142413526fb93e25fa2d6a; offer_waitlist_seats md5 a7e4ff44e71af1b41980a54c755f1186'
  union all
  select 2, 'functions', 'both now close a session with event_booking_closed(...) and no longer with the UTC current_date',
    coalesce((select string_agg(proname || ': event_booking_closed ' || (strpos(prosrc, 'event_booking_closed(v_event.event_date, v_event.timezone, v_event.status)') > 0)::text
                                || ', current_date ' || (strpos(prosrc, 'current_date') > 0)::text, '; ' order by proname) from fn), 'missing'),
    'join_waitlist: event_booking_closed true, current_date false; offer_waitlist_seats: event_booking_closed true, current_date false',
    coalesce((select count(*) = 2 and bool_and(strpos(prosrc, 'event_booking_closed(v_event.event_date, v_event.timezone, v_event.status)') > 0
                                               and strpos(prosrc, 'current_date') = 0) from fn), false)
  union all
  select 3, 'functions', 'join_waitlist contract unchanged: one definition, (p_event_id uuid, p_quantity integer DEFAULT 1) → jsonb, SECURITY DEFINER, search_path=public',
    (select count(*) from fn where proname = 'join_waitlist')::text || ' definition(s); '
      || coalesce((select string_agg(args || ' → ' || result || '; security definer ' || prosecdef::text || '; config ' || coalesce(array_to_string(proconfig, ','), '-'), ', ')
                   from fn where proname = 'join_waitlist'), '-'),
    '1 definition(s); p_event_id uuid, p_quantity integer DEFAULT 1 → jsonb; security definer true; config search_path=public',
    (select count(*) = 1 and bool_and(args = 'p_event_id uuid, p_quantity integer DEFAULT 1' and result = 'jsonb' and prosecdef and proconfig = array['search_path=public'])
       from fn where proname = 'join_waitlist')
  union all
  select 4, 'functions', 'offer_waitlist_seats contract unchanged: one definition, (p_event_id uuid) → integer, SECURITY DEFINER, search_path=public',
    (select count(*) from fn where proname = 'offer_waitlist_seats')::text || ' definition(s); '
      || coalesce((select string_agg(args || ' → ' || result || '; security definer ' || prosecdef::text || '; config ' || coalesce(array_to_string(proconfig, ','), '-'), ', ')
                   from fn where proname = 'offer_waitlist_seats'), '-'),
    '1 definition(s); p_event_id uuid → integer; security definer true; config search_path=public',
    (select count(*) = 1 and bool_and(args = 'p_event_id uuid' and result = 'integer' and prosecdef and proconfig = array['search_path=public'])
       from fn where proname = 'offer_waitlist_seats')
  union all
  select 5, 'grants', 'grants kept: join_waitlist — authenticated yes, anon no; offer_waitlist_seats — neither',
    coalesce((select string_agg(proname || ': anon ' || has_function_privilege('anon', oid, 'EXECUTE')::text
                                || ', authenticated ' || has_function_privilege('authenticated', oid, 'EXECUTE')::text, '; ' order by proname) from fn), 'missing'),
    'join_waitlist: anon false, authenticated true; offer_waitlist_seats: anon false, authenticated false',
    coalesce((select string_agg(proname || ': anon ' || has_function_privilege('anon', oid, 'EXECUTE')::text
                                || ', authenticated ' || has_function_privilege('authenticated', oid, 'EXECUTE')::text, '; ' order by proname) from fn), '')
      = 'join_waitlist: anon false, authenticated true; offer_waitlist_seats: anon false, authenticated false'
  union all
  select 6, 'grants', 'service_role can still execute both (server-side jobs)',
    coalesce((select string_agg(proname || ' ' || has_function_privilege('service_role', oid, 'EXECUTE')::text, '; ' order by proname) from fn), 'missing'),
    'join_waitlist true; offer_waitlist_seats true',
    coalesce((select count(*) = 2 and bool_and(has_function_privilege('service_role', oid, 'EXECUTE')) from fn), false)
  union all
  select 7, 'grants', 'their owner can execute event_booking_closed (what they now call)',
    coalesce((select string_agg(proname || ' owner ' || pg_get_userbyid(proowner) || ' can execute: '
                                || has_function_privilege(proowner, (select oid from ebc), 'EXECUTE')::text, '; ' order by proname)
              from fn where exists (select 1 from ebc)), 'missing'),
    'can execute: true (both)',
    coalesce((select count(*) = 2 and bool_and(has_function_privilege(proowner, (select oid from ebc), 'EXECUTE')) from fn where exists (select 1 from ebc)), false)
  union all
  select 8, 'unchanged', 'event_booking_closed is still the 0038 version',
    coalesce((select 'md5 ' || md5(prosrc) from ebc), 'missing'), 'md5 3ba1c9cb4ae8955066fea4fa6b987621',
    coalesce((select md5(prosrc) = '3ba1c9cb4ae8955066fea4fa6b987621' from ebc), false)
  union all
  select 9, 'unchanged', 'the six calling functions still exist',
    coalesce((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.proname not in ('join_waitlist', 'offer_waitlist_seats')
                and (p.prosrc ~ '\mjoin_waitlist\(' or p.prosrc ~ '\moffer_waitlist_seats\(')), 'none'),
    'admin_offer_waitlist, admin_remove_waitlist_entry, expire_waitlist_offers, leave_waitlist, waitlist_on_booking_release, waitlist_on_capacity_change',
    coalesce((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.proname not in ('join_waitlist', 'offer_waitlist_seats')
                and (p.prosrc ~ '\mjoin_waitlist\(' or p.prosrc ~ '\moffer_waitlist_seats\(')), '')
      = 'admin_offer_waitlist, admin_remove_waitlist_entry, expire_waitlist_offers, leave_waitlist, waitlist_on_booking_release, waitlist_on_capacity_change'
  union all
  select 10, 'unchanged', 'events_validate_timezone trigger still enabled on events',
    exists (select 1 from pg_trigger where tgname = 'events_validate_timezone' and tgrelid = to_regclass('public.events') and tgenabled = 'O')::text, 'true',
    exists (select 1 from pg_trigger where tgname = 'events_validate_timezone' and tgrelid = to_regclass('public.events') and tgenabled = 'O')
  union all
  select 11, 'unchanged', '0043 still in effect (set_programme_sessions + 0043 sync_artist_application_status)',
    (to_regprocedure('public.set_programme_sessions(uuid,uuid[])') is not null
     and coalesce((select bool_and(md5(prosrc) = '60769a587bedd48bb26183f627a89928') from pg_proc
                   where pronamespace = 'public'::regnamespace and proname = 'sync_artist_application_status'), false))::text,
    'true',
    to_regprocedure('public.set_programme_sessions(uuid,uuid[])') is not null
     and coalesce((select bool_and(md5(prosrc) = '60769a587bedd48bb26183f627a89928') from pg_proc
                   where pronamespace = 'public'::regnamespace and proname = 'sync_artist_application_status'), false)
  union all
  select 12, 'unchanged', '0042 and 0045 still in effect (public_artists: public name; read-only for anon / authenticated)',
    coalesce((select (strpos(pg_get_viewdef(c.oid), 'COALESCE(NULLIF(btrim(') > 0
                      and not has_any_column_privilege('anon', c.oid, 'UPDATE') and not has_table_privilege('anon', c.oid, 'DELETE')
                      and not has_any_column_privilege('authenticated', c.oid, 'UPDATE') and not has_table_privilege('authenticated', c.oid, 'DELETE'))::text
              from pg_class c where c.oid = to_regclass('public.public_artists')), 'missing'),
    'true',
    coalesce((select strpos(pg_get_viewdef(c.oid), 'COALESCE(NULLIF(btrim(') > 0
                     and not has_any_column_privilege('anon', c.oid, 'UPDATE') and not has_table_privilege('anon', c.oid, 'DELETE')
                     and not has_any_column_privilege('authenticated', c.oid, 'UPDATE') and not has_table_privilege('authenticated', c.oid, 'DELETE')
              from pg_class c where c.oid = to_regclass('public.public_artists')), false)
  union all
  select 13, 'unchanged', 'the waitlist table is unchanged in shape (columns and grants are part of row 15)',
    (to_regclass('public.waitlist') is not null)::text, 'true', to_regclass('public.waitlist') is not null
  union all
  select 14, 'data', 'row counts (informational; must equal preflight row 16)',
    concat_ws('; ', 'events ' || (select count(*) from events)::text, 'waitlist ' || (select count(*) from waitlist)::text,
                    'bookings ' || (select count(*) from bookings)::text),
    'same as preflight row 16', true
  union all
  select 15, 'drift', 'fingerprint of everything 0044 must not touch (informational; must equal preflight row 17)',
    (select n::text || ' objects, md5 ' || h from fp), 'same as preflight row 17', true
)
select ord, area, check_name, result, expected, ok
from checks
union all
select 99, 'verdict', 'VERDICT',
  case when bool_and(ok) then 'ALL CHECKS PASSED — 0044 applied as intended' else 'STOP — at least one check failed' end,
  'ALL CHECKS PASSED — 0044 applied as intended', bool_and(ok)
from checks
order by ord;
