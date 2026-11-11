-- READ-ONLY check AFTER applying 0043_atomic_programme_sessions.sql — ONE
-- SELECT statement; it cannot change anything. Every row must show
-- ok = true; the last row is the verdict. Rows 16 and 17 must show exactly
-- what preflight rows 19 and 21 showed (0043 changes no data and nothing
-- besides its two functions).
with
fn_sync as (
  select p.oid, p.prosrc, p.prosecdef, p.proconfig, p.prorettype
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'sync_artist_application_status'
),
fn_sps as (
  select p.oid, p.prosrc, p.prosecdef, p.proconfig, p.prorettype, p.provolatile, p.proacl, p.prolang
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'set_programme_sessions'
),
pe_policies as (
  select string_agg(policyname || ' [' || cmd || ' ' || array_to_string(roles, ',') || ' ' || permissive || '] USING '
           || coalesce(btrim(regexp_replace(regexp_replace(regexp_replace(replace(qual, '"', ''), '\m(public|artists|objects)\.', '', 'g'), '::[A-Za-z_][A-Za-z0-9_.]*(\[\])?', '', 'g'), '\s+', ' ', 'g'), ' ;'), '-')
           || ' CHECK '
           || coalesce(btrim(regexp_replace(regexp_replace(regexp_replace(replace(with_check, '"', ''), '\m(public|artists|objects)\.', '', 'g'), '::[A-Za-z_][A-Za-z0-9_.]*(\[\])?', '', 'g'), '\s+', ' ', 'g'), ' ;'), '-'),
           ' ; ' order by policyname) as list
  from pg_policies where schemaname = 'public' and tablename = 'programme_events'
),
pe_constraints as (
  select string_agg(conname || '=' || replace(pg_get_constraintdef(oid), 'public.', ''), ' ; ' order by conname) as list
  from pg_constraint where conrelid = to_regclass('public.programme_events')
),
pe_columns as (
  select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position) as list
  from information_schema.columns where table_schema = 'public' and table_name = 'programme_events'
),
-- Same fingerprint as the preflight (row 21): everything except the two functions 0043 creates / replaces.
fp as (
  select md5(string_agg(x, E'\n' order by x)) as h, count(*) as n from (
    select 'fn ' || p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(p.proacl::text, '-') as x
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
        and p.proname not in ('set_programme_sessions', 'sync_artist_application_status')
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
  -- 1. The new function, exactly as 0043 defines it.
  select 1, 'new function', 'set_programme_sessions: exactly one, (p_programme_id uuid, p_event_ids uuid[]) returns integer',
    (select count(*) from fn_sps)::text || ' definition(s); ' || coalesce((select string_agg(pg_get_function_identity_arguments(oid) || ' → ' || pg_get_function_result(oid), ', ') from fn_sps), '-'),
    '1 definition(s); p_programme_id uuid, p_event_ids uuid[] → integer',
    (select count(*) = 1 and bool_and(pg_get_function_identity_arguments(oid) = 'p_programme_id uuid, p_event_ids uuid[]' and prorettype = 'integer'::regtype) from fn_sps)
  union all
  select 2, 'new function', 'set_programme_sessions: the 0043 body (delete + insert in one call), plpgsql, SECURITY INVOKER, search_path=public',
    coalesce((select concat_ws('; ', 'md5 ' || md5(prosrc), 'language ' || (select lanname from pg_language where oid = prolang),
                               'security definer ' || prosecdef::text, 'config ' || coalesce(array_to_string(proconfig, ','), '-')) from fn_sps), 'missing'),
    'md5 feefdc6f4499ac128cb0bbbfe7f01f44; language plpgsql; security definer false; config search_path=public',
    coalesce((select bool_and(md5(prosrc) = 'feefdc6f4499ac128cb0bbbfe7f01f44' and not prosecdef and proconfig = array['search_path=public']
                              and prolang = (select oid from pg_language where lanname = 'plpgsql')) from fn_sps), false)
  union all
  select 3, 'new function', 'authenticated can EXECUTE set_programme_sessions (the console calls it)',
    coalesce((select bool_and(has_function_privilege('authenticated', oid, 'EXECUTE'))::text from fn_sps), 'missing'), 'true',
    coalesce((select bool_and(has_function_privilege('authenticated', oid, 'EXECUTE')) from fn_sps), false)
  union all
  select 4, 'new function', 'anon cannot EXECUTE set_programme_sessions',
    coalesce((select bool_and(has_function_privilege('anon', oid, 'EXECUTE'))::text from fn_sps), 'missing'), 'false',
    coalesce((select not bool_or(has_function_privilege('anon', oid, 'EXECUTE')) from fn_sps), false)
  union all
  select 5, 'new function', 'PUBLIC has no EXECUTE on set_programme_sessions (explicit ACL, no PUBLIC entry)',
    coalesce((select case when proacl is null then 'no ACL (PUBLIC can execute)'
                          when exists (select 1 from aclexplode(proacl) a where a.grantee = 0) then 'PUBLIC granted'
                          else 'none' end from fn_sps limit 1), 'missing'),
    'none',
    coalesce((select bool_and(proacl is not null and not exists (select 1 from aclexplode(proacl) a where a.grantee = 0)) from fn_sps), false)
  union all
  select 6, 'new function', 'service_role EXECUTE (informational: from default privileges; content_can() still refuses a caller without a console role)',
    coalesce((select bool_and(has_function_privilege('service_role', oid, 'EXECUTE'))::text from fn_sps), 'missing'), 'reported', true
  union all
  -- 2. The replaced trigger function.
  select 7, 'artist sync', 'sync_artist_application_status is the 0043 version (also closes needs_information), one definition',
    (select count(*) from fn_sync)::text || ' definition(s), md5 ' || coalesce((select string_agg(md5(prosrc), ',') from fn_sync), '-'),
    '1 definition(s), md5 60769a587bedd48bb26183f627a89928',
    (select count(*) = 1 and bool_and(md5(prosrc) = '60769a587bedd48bb26183f627a89928') from fn_sync)
  union all
  select 8, 'artist sync', 'sync_artist_application_status: still a SECURITY DEFINER trigger function, search_path=public',
    coalesce((select concat_ws('; ', 'returns ' || prorettype::regtype::text, 'security definer ' || prosecdef::text,
                               'config ' || coalesce(array_to_string(proconfig, ','), '-')) from fn_sync), 'missing'),
    'returns trigger; security definer true; config search_path=public',
    coalesce((select prorettype = 'trigger'::regtype and prosecdef and proconfig = array['search_path=public'] from fn_sync), false)
  union all
  select 9, 'artist sync', 'sync_artist_application_status: anon / authenticated still cannot EXECUTE (0035 grants kept)',
    coalesce((select concat_ws('; ', 'anon ' || has_function_privilege('anon', oid, 'EXECUTE')::text,
                               'authenticated ' || has_function_privilege('authenticated', oid, 'EXECUTE')::text) from fn_sync), 'missing'),
    'anon false; authenticated false',
    coalesce((select not has_function_privilege('anon', oid, 'EXECUTE') and not has_function_privilege('authenticated', oid, 'EXECUTE') from fn_sync), false)
  union all
  select 10, 'artist sync', 'trigger artists_sync_application unchanged and enabled',
    coalesce((select string_agg(t.tgrelid::regclass::text || '.' || t.tgname || ' enabled=' || t.tgenabled::text, '; ')
              from pg_trigger t join fn_sync f on t.tgfoid = f.oid), 'none'),
    'artists.artists_sync_application enabled=O',
    coalesce((select count(*) = 1
                 and bool_and(t.tgrelid = to_regclass('public.artists') and t.tgname = 'artists_sync_application' and t.tgenabled = 'O'
                              and replace(pg_get_triggerdef(t.oid), 'public.', '') = 'CREATE TRIGGER artists_sync_application AFTER UPDATE OF status ON artists FOR EACH ROW EXECUTE FUNCTION sync_artist_application_status()')
              from pg_trigger t join fn_sync f on t.tgfoid = f.oid), false)
  union all
  -- 3. What must be unchanged.
  select 11, 'unchanged', 'programme_events columns, keys, RLS, policies and authenticated grants as before (0031)',
    case when coalesce((select list from pe_columns), '') = 'programme_id:uuid:NO,event_id:uuid:NO,position:integer:NO'
          and coalesce((select list from pe_constraints), '') = 'programme_events_event_id_fkey=FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE ; programme_events_pkey=PRIMARY KEY (programme_id, event_id) ; programme_events_programme_id_fkey=FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE CASCADE'
          and coalesce((select relrowsecurity and (select count(*) from pg_trigger where tgrelid = c.oid and not tgisinternal) = 0 from pg_class c where c.oid = to_regclass('public.programme_events')), false)
          and coalesce((select list from pe_policies), '') = 'programme_events: console read [SELECT authenticated PERMISSIVE] USING content_can(''view'', ''sessions'') CHECK - ; programme_events: public published [SELECT public PERMISSIVE] USING (EXISTS ( SELECT 1 FROM programmes p WHERE ((p.id = programme_events.programme_id) AND (p.status = ''published'') AND (p.published_at <= now())))) CHECK - ; programme_events: write [ALL authenticated PERMISSIVE] USING content_can(''edit'', ''sessions'') CHECK content_can(''edit'', ''sessions'')'
          and has_table_privilege('authenticated', 'public.programmes', 'SELECT') and has_table_privilege('authenticated', 'public.programme_events', 'SELECT')
          and has_table_privilege('authenticated', 'public.programme_events', 'INSERT') and has_table_privilege('authenticated', 'public.programme_events', 'DELETE')
         then 'unchanged' else 'CHANGED: ' || coalesce((select list from pe_columns), '-') || ' / ' || coalesce((select list from pe_constraints), '-') || ' / ' || coalesce((select list from pe_policies), '-') end,
    'unchanged',
    coalesce((select list from pe_columns), '') = 'programme_id:uuid:NO,event_id:uuid:NO,position:integer:NO'
      and coalesce((select list from pe_constraints), '') = 'programme_events_event_id_fkey=FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE ; programme_events_pkey=PRIMARY KEY (programme_id, event_id) ; programme_events_programme_id_fkey=FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE CASCADE'
      and coalesce((select relrowsecurity and (select count(*) from pg_trigger where tgrelid = c.oid and not tgisinternal) = 0 from pg_class c where c.oid = to_regclass('public.programme_events')), false)
      and coalesce((select list from pe_policies), '') = 'programme_events: console read [SELECT authenticated PERMISSIVE] USING content_can(''view'', ''sessions'') CHECK - ; programme_events: public published [SELECT public PERMISSIVE] USING (EXISTS ( SELECT 1 FROM programmes p WHERE ((p.id = programme_events.programme_id) AND (p.status = ''published'') AND (p.published_at <= now())))) CHECK - ; programme_events: write [ALL authenticated PERMISSIVE] USING content_can(''edit'', ''sessions'') CHECK content_can(''edit'', ''sessions'')'
      and has_table_privilege('authenticated', 'public.programmes', 'SELECT') and has_table_privilege('authenticated', 'public.programme_events', 'SELECT')
      and has_table_privilege('authenticated', 'public.programme_events', 'INSERT') and has_table_privilege('authenticated', 'public.programme_events', 'DELETE')
  union all
  select 12, 'unchanged', 'dependencies intact: content_can(text, text); guard_artist_application (0033) attached',
    concat_ws('; ', 'content_can ' || (to_regprocedure('public.content_can(text,text)') is not null)::text,
      'guard md5 ' || coalesce((select string_agg(md5(prosrc), ',') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'guard_artist_application'), '-'),
      'guard trigger ' || exists (select 1 from pg_trigger where tgname = 'artist_applications_guard' and tgrelid = to_regclass('public.artist_applications'))::text),
    'content_can true; guard md5 ea123cfad6a691c937ab90556d7c73c6; guard trigger true',
    to_regprocedure('public.content_can(text,text)') is not null
      and coalesce((select count(*) = 1 and bool_and(md5(prosrc) = 'ea123cfad6a691c937ab90556d7c73c6') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'guard_artist_application'), false)
      and exists (select 1 from pg_trigger where tgname = 'artist_applications_guard' and tgrelid = to_regclass('public.artist_applications'))
  union all
  select 13, 'unchanged', '0044 still applicable on its own: event_booking_closed (0038) present; join_waitlist / offer_waitlist_seats still the pre-0044 bodies',
    concat_ws('; ',
      'event_booking_closed ' || (to_regprocedure('public.event_booking_closed(date,text,text,timestamptz)') is not null)::text,
      'join_waitlist md5 ' || coalesce((select string_agg(md5(prosrc), ',') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'join_waitlist'), '-'),
      'offer_waitlist_seats md5 ' || coalesce((select string_agg(md5(prosrc), ',') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'offer_waitlist_seats'), '-')),
    'event_booking_closed true; join_waitlist md5 c266d17ee0cb72ae8842aea2c08de0fe; offer_waitlist_seats md5 3959b59642c26ec444549309a1dd93da',
    to_regprocedure('public.event_booking_closed(date,text,text,timestamptz)') is not null
      and coalesce((select count(*) = 1 and bool_and(md5(prosrc) = 'c266d17ee0cb72ae8842aea2c08de0fe') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'join_waitlist'), false)
      and coalesce((select count(*) = 1 and bool_and(md5(prosrc) = '3959b59642c26ec444549309a1dd93da') from pg_proc where pronamespace = 'public'::regnamespace and proname = 'offer_waitlist_seats'), false)
  union all
  select 14, 'unchanged', '0042 still in effect (public_artists.name is the public display name)',
    coalesce(strpos(pg_get_viewdef(to_regclass('public.public_artists')), 'COALESCE(NULLIF(btrim(') > 0, false)::text, 'true',
    coalesce(strpos(pg_get_viewdef(to_regclass('public.public_artists')), 'COALESCE(NULLIF(btrim(') > 0, false)
  union all
  select 15, 'unchanged', '0045 still in effect (anon / authenticated cannot write public_artists)',
    coalesce((select (not has_any_column_privilege('anon', c.oid, 'UPDATE') and not has_table_privilege('anon', c.oid, 'DELETE')
                      and not has_any_column_privilege('authenticated', c.oid, 'UPDATE') and not has_table_privilege('authenticated', c.oid, 'DELETE'))::text
              from pg_class c where c.oid = to_regclass('public.public_artists')), 'missing'),
    'true',
    coalesce((select not has_any_column_privilege('anon', c.oid, 'UPDATE') and not has_table_privilege('anon', c.oid, 'DELETE')
                     and not has_any_column_privilege('authenticated', c.oid, 'UPDATE') and not has_table_privilege('authenticated', c.oid, 'DELETE')
              from pg_class c where c.oid = to_regclass('public.public_artists')), false)
  union all
  select 16, 'data', 'row counts (informational; must equal preflight row 19)',
    concat_ws('; ',
      'programmes ' || (select count(*) from programmes)::text,
      'programme_events ' || (select count(*) from programme_events)::text,
      'artists ' || (select count(*) from artists)::text,
      'artist_applications ' || (select count(*) from artist_applications)::text),
    'same as preflight row 19', true
  union all
  select 17, 'drift', 'fingerprint of everything 0043 must not touch (informational; must equal preflight row 21)',
    (select n::text || ' objects, md5 ' || h from fp), 'same as preflight row 21', true
)
select ord, area, check_name, result, expected, ok
from checks
union all
select 99, 'verdict', 'VERDICT',
  case when bool_and(ok) then 'ALL CHECKS PASSED — 0043 applied as intended' else 'STOP — at least one check failed' end,
  'ALL CHECKS PASSED — 0043 applied as intended', bool_and(ok)
from checks
order by ord;
