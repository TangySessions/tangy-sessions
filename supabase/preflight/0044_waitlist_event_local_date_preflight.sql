-- READ-ONLY preflight for 0044_waitlist_event_local_date.sql — ONE SELECT
-- statement (the Supabase SQL editor shows only the last result). It reads
-- catalogs and counts rows; it cannot change anything.
--
-- 0044 changes no data. It replaces the bodies of join_waitlist(uuid, integer)
-- (0027) and offer_waitlist_seats(uuid) (0029): their "is this session over?"
-- test becomes event_booking_closed(event_date, timezone, status) (0038 — the
-- event's own timezone) instead of the database's UTC current_date. Same
-- signatures, defaults, return types, SECURITY DEFINER and search_path; CREATE
-- OR REPLACE keeps owner and grants. Both run as their owner, so the owner must
-- be able to execute event_booking_closed (only postgres / service_role may).
-- The six functions that call them by name are unaffected.
--
-- Every row must show ok = true; the last row is the verdict. Rows marked
-- (informational) are always ok; rows 16 and 17 are recorded so the
-- post-check can show they did not change. Rows 13 and 14 apply 0038's
-- local-date rule inline (row 4 proves event_booking_closed is that rule),
-- so this query never calls a function it has just found missing or changed.
with
fn as (
  select p.oid, p.proname, p.prosrc, p.prosecdef, p.proconfig, p.proowner, p.proacl,
         pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as result
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('join_waitlist', 'offer_waitlist_seats')
),
ebc as (
  select p.oid, p.prosrc, pg_get_function_result(p.oid) as result from pg_proc p
  where p.oid = to_regprocedure('public.event_booking_closed(date,text,text,timestamptz)')
),
-- Everything 0044 must NOT touch (same hash as post-check row 15): every other public function, grants and
-- options of tables/views, columns, views, policies, triggers, indexes and constraints.
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
  -- Baseline: the verified production state (0037–0043 + 0045), 0044 not yet applied.
  select 1, 'baseline', '0043 applied (set_programme_sessions + 0043 sync_artist_application_status)',
    (to_regprocedure('public.set_programme_sessions(uuid,uuid[])') is not null
     and coalesce((select bool_and(md5(prosrc) = '60769a587bedd48bb26183f627a89928') from pg_proc
                   where pronamespace = 'public'::regnamespace and proname = 'sync_artist_application_status'), false))::text,
    'true',
    to_regprocedure('public.set_programme_sessions(uuid,uuid[])') is not null
     and coalesce((select bool_and(md5(prosrc) = '60769a587bedd48bb26183f627a89928') from pg_proc
                   where pronamespace = 'public'::regnamespace and proname = 'sync_artist_application_status'), false)
  union all
  select 2, 'baseline', '0042 applied and 0045 applied (public_artists: public name; read-only for anon / authenticated)',
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
  select 3, 'baseline', '0044 not yet applied: join_waitlist / offer_waitlist_seats are exactly the 0027 / 0029 bodies',
    coalesce((select string_agg(proname || ' md5 ' || md5(prosrc), '; ' order by proname) from fn), 'missing'),
    'join_waitlist md5 c266d17ee0cb72ae8842aea2c08de0fe; offer_waitlist_seats md5 3959b59642c26ec444549309a1dd93da',
    coalesce((select string_agg(proname || ' md5 ' || md5(prosrc), '; ' order by proname) from fn), '')
      = 'join_waitlist md5 c266d17ee0cb72ae8842aea2c08de0fe; offer_waitlist_seats md5 3959b59642c26ec444549309a1dd93da'
  union all
  -- The one new dependency: event_booking_closed (0038).
  select 4, 'dependencies', 'event_booking_closed(date, text, text, timestamptz) is the 0038 version, returns boolean',
    coalesce((select 'md5 ' || md5(prosrc) || '; returns ' || result from ebc), 'missing'),
    'md5 3ba1c9cb4ae8955066fea4fa6b987621; returns boolean',
    coalesce((select md5(prosrc) = '3ba1c9cb4ae8955066fea4fa6b987621' and result = 'boolean' from ebc), false)
  union all
  select 5, 'dependencies', 'event_booking_closed: last parameter defaults to now() (0044 calls it with three arguments)',
    coalesce((select pg_get_function_arguments(oid) from ebc), 'missing'),
    'p_event_date date, p_timezone text, p_status text, p_at timestamp with time zone DEFAULT now()',
    coalesce((select pg_get_function_arguments(oid) = 'p_event_date date, p_timezone text, p_status text, p_at timestamp with time zone DEFAULT now()' from ebc), false)
  union all
  -- The two functions 0044 replaces: CREATE OR REPLACE needs the same signature, defaults and return type.
  select 6, 'functions', 'join_waitlist: one definition, (p_event_id uuid, p_quantity integer DEFAULT 1) → jsonb, SECURITY DEFINER, search_path=public',
    (select count(*) from fn where proname = 'join_waitlist')::text || ' definition(s); '
      || coalesce((select string_agg(args || ' → ' || result || '; security definer ' || prosecdef::text || '; config ' || coalesce(array_to_string(proconfig, ','), '-'), ', ')
                   from fn where proname = 'join_waitlist'), '-'),
    '1 definition(s); p_event_id uuid, p_quantity integer DEFAULT 1 → jsonb; security definer true; config search_path=public',
    (select count(*) = 1 and bool_and(args = 'p_event_id uuid, p_quantity integer DEFAULT 1' and result = 'jsonb' and prosecdef and proconfig = array['search_path=public'])
       from fn where proname = 'join_waitlist')
  union all
  select 7, 'functions', 'offer_waitlist_seats: one definition, (p_event_id uuid) → integer, SECURITY DEFINER, search_path=public',
    (select count(*) from fn where proname = 'offer_waitlist_seats')::text || ' definition(s); '
      || coalesce((select string_agg(args || ' → ' || result || '; security definer ' || prosecdef::text || '; config ' || coalesce(array_to_string(proconfig, ','), '-'), ', ')
                   from fn where proname = 'offer_waitlist_seats'), '-'),
    '1 definition(s); p_event_id uuid → integer; security definer true; config search_path=public',
    (select count(*) = 1 and bool_and(args = 'p_event_id uuid' and result = 'integer' and prosecdef and proconfig = array['search_path=public'])
       from fn where proname = 'offer_waitlist_seats')
  union all
  select 8, 'functions', 'their owner can execute event_booking_closed (they run as the owner; otherwise every waitlist call would fail)',
    coalesce((select string_agg(proname || ' owner ' || pg_get_userbyid(proowner) || ' can execute: '
                                || has_function_privilege(proowner, (select oid from ebc), 'EXECUTE')::text, '; ' order by proname)
              from fn where exists (select 1 from ebc)), 'missing'),
    'join_waitlist owner … can execute: true; offer_waitlist_seats owner … can execute: true',
    coalesce((select count(*) = 2 and bool_and(has_function_privilege(proowner, (select oid from ebc), 'EXECUTE'))
              from fn where exists (select 1 from ebc)), false)
  union all
  select 9, 'functions', 'grants (kept by 0044): join_waitlist — authenticated yes, anon no; offer_waitlist_seats — neither',
    coalesce((select string_agg(proname || ': anon ' || has_function_privilege('anon', oid, 'EXECUTE')::text
                                || ', authenticated ' || has_function_privilege('authenticated', oid, 'EXECUTE')::text, '; ' order by proname) from fn), 'missing'),
    'join_waitlist: anon false, authenticated true; offer_waitlist_seats: anon false, authenticated false',
    coalesce((select string_agg(proname || ': anon ' || has_function_privilege('anon', oid, 'EXECUTE')::text
                                || ', authenticated ' || has_function_privilege('authenticated', oid, 'EXECUTE')::text, '; ' order by proname) from fn), '')
      = 'join_waitlist: anon false, authenticated true; offer_waitlist_seats: anon false, authenticated false'
  union all
  select 10, 'apply', 'current user can replace both functions (owner or member of the owner role)',
    'current_user ' || current_user || '; ' || coalesce((select string_agg(proname || ' owner ' || pg_get_userbyid(proowner)
       || ' (can act as owner: ' || pg_has_role(current_user, proowner, 'MEMBER')::text || ')', '; ' order by proname) from fn), 'missing'),
    'can act as owner: true (both)',
    coalesce((select count(*) = 2 and bool_and(pg_has_role(current_user, proowner, 'MEMBER')) from fn), false)
  union all
  -- What the new test reads: events.event_date / timezone / status.
  select 11, 'events', 'events.event_date (date) / timezone (text NOT NULL) / status (text) exist; timezone validated by events_validate_timezone',
    coalesce((select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name) from information_schema.columns
              where table_schema = 'public' and table_name = 'events' and column_name in ('event_date', 'timezone', 'status')), 'missing')
      || '; trigger ' || exists (select 1 from pg_trigger where tgname = 'events_validate_timezone' and tgrelid = to_regclass('public.events') and tgenabled = 'O')::text,
    'event_date:date:NO,status:text:NO,timezone:text:NO; trigger true',
    coalesce((select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name) from information_schema.columns
              where table_schema = 'public' and table_name = 'events' and column_name in ('event_date', 'timezone', 'status')), '')
      = 'event_date:date:NO,status:text:NO,timezone:text:NO'
      and exists (select 1 from pg_trigger where tgname = 'events_validate_timezone' and tgrelid = to_regclass('public.events') and tgenabled = 'O')
  union all
  -- Data: 0044 changes none, but the new test would raise an error for an event with an unknown timezone.
  select 12, 'data', 'every event has a known IANA timezone (the new date test would raise an error otherwise)',
    (select count(*) from events e where not exists (select 1 from pg_timezone_names z where z.name = e.timezone))::text, '0',
    not exists (select 1 from events e where not exists (select 1 from pg_timezone_names z where z.name = e.timezone))
  union all
  select 13, 'data', 'waitlist entries still open for a session that is over by the local-date rule (informational; 0044 does not change rows, only stops new joins / offers)',
    (select count(*) from waitlist w join events e on e.id = w.event_id
      where w.status in ('waiting', 'offered')
        and (e.status = 'past' or e.event_date < case when exists (select 1 from pg_timezone_names z where z.name = coalesce(nullif(e.timezone, ''), 'Asia/Kolkata'))
                                                      then (now() at time zone coalesce(nullif(e.timezone, ''), 'Asia/Kolkata'))::date end))::text,
    'any (0 on an empty database)', true
  union all
  select 14, 'data', 'sessions whose open / closed answer changes with 0044 right now (informational: UTC date vs local date disagree)',
    (select count(*) from events e
      where exists (select 1 from pg_timezone_names z where z.name = coalesce(nullif(e.timezone, ''), 'Asia/Kolkata'))
        and (e.status = 'past' or e.event_date < current_date)
            is distinct from (e.status = 'past' or e.event_date < case when exists (select 1 from pg_timezone_names z where z.name = coalesce(nullif(e.timezone, ''), 'Asia/Kolkata'))
                                                                       then (now() at time zone coalesce(nullif(e.timezone, ''), 'Asia/Kolkata'))::date end))::text,
    'any (depends on the time of day; 0 on an empty database)', true
  union all
  select 15, 'callers', 'functions that call join_waitlist / offer_waitlist_seats by name (informational; unaffected — same signatures)',
    coalesce((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.proname not in ('join_waitlist', 'offer_waitlist_seats')
                and (p.prosrc ~ '\mjoin_waitlist\(' or p.prosrc ~ '\moffer_waitlist_seats\(')), 'none'),
    'admin_offer_waitlist, admin_remove_waitlist_entry, expire_waitlist_offers, leave_waitlist, waitlist_on_booking_release, waitlist_on_capacity_change', true
  union all
  select 16, 'data', 'row counts (informational; post-check row 14 must show the same)',
    concat_ws('; ', 'events ' || (select count(*) from events)::text, 'waitlist ' || (select count(*) from waitlist)::text,
                    'bookings ' || (select count(*) from bookings)::text),
    'reported', true
  union all
  select 17, 'drift', 'fingerprint of everything 0044 must not touch (informational; post-check row 15 must show the same)',
    (select n::text || ' objects, md5 ' || h from fp), 'reported', true
)
select ord, area, check_name, result, expected, ok
from checks
union all
select 99, 'verdict', 'VERDICT',
  case when bool_and(ok) then 'ALL CHECKS PASSED — safe to apply 0044' else 'STOP — at least one check failed' end,
  'ALL CHECKS PASSED — safe to apply 0044', bool_and(ok)
from checks
order by ord;
