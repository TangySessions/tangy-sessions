-- READ-ONLY preflight for 0043_atomic_programme_sessions.sql — ONE SELECT
-- statement (the Supabase SQL editor shows only the last result). It reads
-- catalogs and counts rows; it cannot change anything.
--
-- 0043 changes no data. It (1) creates set_programme_sessions(uuid, uuid[]),
-- a SECURITY INVOKER function that replaces a programme's programme_events
-- rows in one transaction — so it relies on programme_events / programmes as
-- 0031 left them (columns, keys, RLS policies, grants to authenticated) and
-- on content_can(text, text) from 0028; and (2) replaces the body of the
-- trigger function sync_artist_application_status() (0033) so a decision on
-- the artist row also closes an application waiting in needs_information —
-- relying on the artists_sync_application trigger and on
-- guard_artist_application() letting the sync through (tangy.application_rpc).
-- It needs nothing from 0044, and 0044 needs nothing from it.
--
-- Every row must show ok = true; the last row is the verdict. Rows marked
-- (informational) are always ok; rows 19 and 21 are recorded so the
-- post-check can show they did not change.
with
fn_sync as (
  select p.oid, p.prosrc, p.prosecdef, p.proconfig, p.prorettype, p.proowner, p.proacl
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'sync_artist_application_status'
),
fn_sps as (
  select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'set_programme_sessions'
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
-- Everything 0043 must NOT touch: every other public function (definition + grants), table/view grants and
-- options, columns, views, policies, triggers, indexes and constraints. The post-check computes the same hash.
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
  -- Baseline: the verified production state (0037–0042 + 0045), 0043 not yet applied.
  select 1, 'baseline', '0042 applied (public_artists.name is the public display name)',
    coalesce(strpos(pg_get_viewdef(to_regclass('public.public_artists')), 'COALESCE(NULLIF(btrim(') > 0, false)::text, 'true',
    coalesce(strpos(pg_get_viewdef(to_regclass('public.public_artists')), 'COALESCE(NULLIF(btrim(') > 0, false)
  union all
  select 2, 'baseline', '0045 applied (anon / authenticated cannot write public_artists)',
    coalesce((select (not has_any_column_privilege('anon', c.oid, 'UPDATE') and not has_table_privilege('anon', c.oid, 'DELETE')
                      and not has_any_column_privilege('authenticated', c.oid, 'UPDATE') and not has_table_privilege('authenticated', c.oid, 'DELETE'))::text
              from pg_class c where c.oid = to_regclass('public.public_artists')), 'missing'),
    'true',
    coalesce((select not has_any_column_privilege('anon', c.oid, 'UPDATE') and not has_table_privilege('anon', c.oid, 'DELETE')
                     and not has_any_column_privilege('authenticated', c.oid, 'UPDATE') and not has_table_privilege('authenticated', c.oid, 'DELETE')
              from pg_class c where c.oid = to_regclass('public.public_artists')), false)
  union all
  select 3, 'baseline', '0043 not yet applied (no set_programme_sessions of any signature)',
    (select count(*) from fn_sps)::text || ' function(s) named set_programme_sessions', '0 function(s) named set_programme_sessions',
    not exists (select 1 from fn_sps)
  union all
  select 4, 'baseline', '0044 status (informational; 0043 does not depend on it)',
    case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'join_waitlist'
                        and strpos(prosrc, 'event_booking_closed(') > 0) then 'applied' else 'not applied' end,
    'either', true
  union all
  -- What set_programme_sessions() relies on.
  select 5, 'dependencies', 'content_can(text, text) exists (0028; called by set_programme_sessions)',
    (to_regprocedure('public.content_can(text,text)') is not null)::text, 'true',
    to_regprocedure('public.content_can(text,text)') is not null
  union all
  select 6, 'programmes', 'programmes table exists (0031)',
    (to_regclass('public.programmes') is not null)::text, 'true',
    to_regclass('public.programmes') is not null
  union all
  select 7, 'programmes', 'programme_events columns (0031)',
    coalesce((select list from pe_columns), 'missing'),
    'programme_id:uuid:NO,event_id:uuid:NO,position:integer:NO',
    coalesce((select list from pe_columns), '') = 'programme_id:uuid:NO,event_id:uuid:NO,position:integer:NO'
  union all
  select 8, 'programmes', 'programme_events keys (primary key + cascading foreign keys, 0031)',
    coalesce((select list from pe_constraints), 'missing'),
    'programme_events_event_id_fkey=FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE ; programme_events_pkey=PRIMARY KEY (programme_id, event_id) ; programme_events_programme_id_fkey=FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE CASCADE',
    coalesce((select list from pe_constraints), '') = 'programme_events_event_id_fkey=FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE ; programme_events_pkey=PRIMARY KEY (programme_id, event_id) ; programme_events_programme_id_fkey=FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE CASCADE'
  union all
  select 9, 'programmes', 'programme_events: RLS on, no triggers (the function''s delete + insert fire nothing else)',
    coalesce((select 'rls ' || relrowsecurity::text || '; triggers ' || (select count(*) from pg_trigger where tgrelid = c.oid and not tgisinternal)
              from pg_class c where c.oid = to_regclass('public.programme_events')), 'missing'),
    'rls true; triggers 0',
    coalesce((select relrowsecurity and (select count(*) from pg_trigger where tgrelid = c.oid and not tgisinternal) = 0
              from pg_class c where c.oid = to_regclass('public.programme_events')), false)
  union all
  select 10, 'programmes', 'programme_events policies are the 0031 ones (normalized; the invoker function obeys them)',
    coalesce((select list from pe_policies), 'missing'),
    'programme_events: console read [SELECT authenticated PERMISSIVE] USING content_can(''view'', ''sessions'') CHECK - ; programme_events: public published [SELECT public PERMISSIVE] USING (EXISTS ( SELECT 1 FROM programmes p WHERE ((p.id = programme_events.programme_id) AND (p.status = ''published'') AND (p.published_at <= now())))) CHECK - ; programme_events: write [ALL authenticated PERMISSIVE] USING content_can(''edit'', ''sessions'') CHECK content_can(''edit'', ''sessions'')',
    coalesce((select list from pe_policies), '') = 'programme_events: console read [SELECT authenticated PERMISSIVE] USING content_can(''view'', ''sessions'') CHECK - ; programme_events: public published [SELECT public PERMISSIVE] USING (EXISTS ( SELECT 1 FROM programmes p WHERE ((p.id = programme_events.programme_id) AND (p.status = ''published'') AND (p.published_at <= now())))) CHECK - ; programme_events: write [ALL authenticated PERMISSIVE] USING content_can(''edit'', ''sessions'') CHECK content_can(''edit'', ''sessions'')'
  union all
  select 11, 'programmes', 'authenticated may SELECT programmes and SELECT / INSERT / DELETE programme_events (0031 grants)',
    coalesce((select concat_ws('; ',
       'programmes SELECT ' || has_table_privilege('authenticated', 'public.programmes', 'SELECT')::text,
       'programme_events SELECT ' || has_table_privilege('authenticated', 'public.programme_events', 'SELECT')::text,
       'INSERT ' || has_table_privilege('authenticated', 'public.programme_events', 'INSERT')::text,
       'DELETE ' || has_table_privilege('authenticated', 'public.programme_events', 'DELETE')::text)
       where to_regclass('public.programmes') is not null and to_regclass('public.programme_events') is not null), 'missing'),
    'programmes SELECT true; programme_events SELECT true; INSERT true; DELETE true',
    coalesce((select has_table_privilege('authenticated', 'public.programmes', 'SELECT')
                 and has_table_privilege('authenticated', 'public.programme_events', 'SELECT')
                 and has_table_privilege('authenticated', 'public.programme_events', 'INSERT')
                 and has_table_privilege('authenticated', 'public.programme_events', 'DELETE')
       where to_regclass('public.programmes') is not null and to_regclass('public.programme_events') is not null), false)
  union all
  -- What the sync_artist_application_status() replacement relies on.
  select 12, 'artist sync', 'sync_artist_application_status() is exactly the 0033 version (one definition, source md5)',
    (select count(*) from fn_sync)::text || ' definition(s), md5 ' || coalesce((select string_agg(md5(prosrc), ',') from fn_sync), '-'),
    '1 definition(s), md5 1240035f244057943ac1857bd2588a4b',
    (select count(*) = 1 and bool_and(md5(prosrc) = '1240035f244057943ac1857bd2588a4b') from fn_sync)
  union all
  select 13, 'artist sync', 'sync_artist_application_status(): trigger function, SECURITY DEFINER, search_path=public',
    coalesce((select concat_ws('; ', 'returns ' || prorettype::regtype::text, 'security definer ' || prosecdef::text,
                               'config ' || coalesce(array_to_string(proconfig, ','), '-')) from fn_sync), 'missing'),
    'returns trigger; security definer true; config search_path=public',
    coalesce((select prorettype = 'trigger'::regtype and prosecdef and proconfig = array['search_path=public'] from fn_sync), false)
  union all
  select 14, 'artist sync', 'sync_artist_application_status(): anon / authenticated cannot EXECUTE (0035); replace keeps this',
    coalesce((select concat_ws('; ', 'anon ' || has_function_privilege('anon', oid, 'EXECUTE')::text,
                               'authenticated ' || has_function_privilege('authenticated', oid, 'EXECUTE')::text) from fn_sync), 'missing'),
    'anon false; authenticated false',
    coalesce((select not has_function_privilege('anon', oid, 'EXECUTE') and not has_function_privilege('authenticated', oid, 'EXECUTE') from fn_sync), false)
  union all
  select 15, 'artist sync', 'trigger artists_sync_application: AFTER UPDATE OF status ON artists, enabled, the only user of the function',
    coalesce((select string_agg(t.tgrelid::regclass::text || '.' || t.tgname || ' enabled=' || t.tgenabled::text, '; ')
              from pg_trigger t join fn_sync f on t.tgfoid = f.oid), 'none'),
    'artists.artists_sync_application enabled=O',
    coalesce((select count(*) = 1
                 and bool_and(t.tgrelid = to_regclass('public.artists') and t.tgname = 'artists_sync_application' and t.tgenabled = 'O'
                              and replace(pg_get_triggerdef(t.oid), 'public.', '') = 'CREATE TRIGGER artists_sync_application AFTER UPDATE OF status ON artists FOR EACH ROW EXECUTE FUNCTION sync_artist_application_status()')
              from pg_trigger t join fn_sync f on t.tgfoid = f.oid), false)
  union all
  select 16, 'artist sync', 'guard_artist_application() is the 0033 version (lets the sync through via tangy.application_rpc) and is attached',
    coalesce((select string_agg('md5 ' || md5(p.prosrc), ',') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'guard_artist_application'), 'missing')
      || '; trigger ' || exists (select 1 from pg_trigger where tgname = 'artist_applications_guard' and tgrelid = to_regclass('public.artist_applications'))::text,
    'md5 ea123cfad6a691c937ab90556d7c73c6; trigger true',
    coalesce((select count(*) = 1 and bool_and(md5(p.prosrc) = 'ea123cfad6a691c937ab90556d7c73c6') from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.proname = 'guard_artist_application'), false)
      and exists (select 1 from pg_trigger where tgname = 'artist_applications_guard' and tgrelid = to_regclass('public.artist_applications'))
  union all
  select 17, 'artist sync', 'artist_applications has artist_id / status / decided_at and allows needs_information, approved, rejected',
    coalesce((select string_agg(column_name, ',' order by column_name) from information_schema.columns
              where table_schema = 'public' and table_name = 'artist_applications' and column_name in ('artist_id', 'status', 'decided_at')), 'missing')
      || '; status check ' || exists (select 1 from pg_constraint where conrelid = to_regclass('public.artist_applications') and contype = 'c'
                                        and strpos(pg_get_constraintdef(oid), '''needs_information''') > 0
                                        and strpos(pg_get_constraintdef(oid), '''approved''') > 0
                                        and strpos(pg_get_constraintdef(oid), '''rejected''') > 0)::text,
    'artist_id,decided_at,status; status check true',
    coalesce((select string_agg(column_name, ',' order by column_name) from information_schema.columns
              where table_schema = 'public' and table_name = 'artist_applications' and column_name in ('artist_id', 'status', 'decided_at')), '') = 'artist_id,decided_at,status'
      and exists (select 1 from pg_constraint where conrelid = to_regclass('public.artist_applications') and contype = 'c'
                    and strpos(pg_get_constraintdef(oid), '''needs_information''') > 0
                    and strpos(pg_get_constraintdef(oid), '''approved''') > 0
                    and strpos(pg_get_constraintdef(oid), '''rejected''') > 0)
  union all
  -- Can this session apply it? (CREATE OR REPLACE FUNCTION needs CREATE on the schema and ownership of the replaced function.)
  select 18, 'apply', 'current user can create in public and owns (or acts as owner of) sync_artist_application_status',
    'current_user ' || current_user || '; CREATE on public ' || has_schema_privilege('public', 'CREATE')::text
      || '; owner ' || coalesce((select pg_get_userbyid(proowner) || ' (can act as owner: ' || pg_has_role(current_user, proowner, 'MEMBER')::text || ')' from fn_sync), 'missing'),
    'CREATE on public true; can act as owner: true',
    has_schema_privilege('public', 'CREATE') and coalesce((select pg_has_role(current_user, proowner, 'MEMBER') from fn_sync), false)
  union all
  -- Data: 0043 transforms none. Recorded so the post-check can show nothing changed.
  select 19, 'data', 'row counts (informational; post-check row 16 must show the same)',
    concat_ws('; ',
      'programmes ' || coalesce((select count(*) from programmes where to_regclass('public.programmes') is not null)::text, '-'),
      'programme_events ' || coalesce((select count(*) from programme_events where to_regclass('public.programme_events') is not null)::text, '-'),
      'artists ' || (select count(*) from artists)::text,
      'artist_applications ' || (select count(*) from artist_applications)::text),
    'reported', true
  union all
  select 20, 'data', 'no application still open although its artist is decided (0043 prevents new ones but does not repair existing rows — review any first)',
    (select count(*) from artist_applications aa join artists a on a.id = aa.artist_id
      where a.status::text in ('approved', 'rejected') and aa.status in ('submitted', 'under_review', 'needs_information'))::text,
    '0',
    not exists (select 1 from artist_applications aa join artists a on a.id = aa.artist_id
      where a.status::text in ('approved', 'rejected') and aa.status in ('submitted', 'under_review', 'needs_information'))
  union all
  select 21, 'drift', 'fingerprint of everything 0043 must not touch (informational; post-check row 17 must show the same)',
    (select n::text || ' objects, md5 ' || h from fp), 'reported', true
)
select ord, area, check_name, result, expected, ok
from checks
union all
select 99, 'verdict', 'VERDICT',
  case when bool_and(ok) then 'ALL CHECKS PASSED — safe to apply 0043' else 'STOP — at least one check failed' end,
  'ALL CHECKS PASSED — safe to apply 0043', bool_and(ok)
from checks
order by ord;
