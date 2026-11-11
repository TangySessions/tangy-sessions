-- READ-ONLY preflight for 0045_public_artists_read_only.sql — ONE SELECT
-- statement (the Supabase SQL editor shows only the last result). It reads
-- catalogs only; it cannot change anything.
--
-- 0045 depends only on the public_artists view as 0042 left it; 0043 and
-- 0044 do not touch the view or its grants, so they may be applied before or
-- after it (row 2 reports them). Every row must show ok = true; the last row
-- is the verdict.
--
-- Row 9: before 0045, anon and authenticated are EXPECTED to hold exactly
-- INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER (Supabase's
-- default privileges — the hole 0045 closes). It passes only if that set is
-- exactly what they hold; rows 10–13 then prove every one of those grants is
-- removable by 0045's REVOKE (made by the view owner, not via PUBLIC, not
-- inherited from another role, and the current user can act as the owner).
-- MAINTAIN (PostgreSQL 17+) is informational only (row 15).
with
v as (
  select c.oid, c.relkind, c.relowner, c.reloptions, c.relacl
  from pg_class c where c.oid = to_regclass('public.public_artists')
),
vdef as (
  select btrim(regexp_replace(regexp_replace(regexp_replace(replace(pg_get_viewdef(v.oid), '"', ''), '\m(public|artists|objects)\.', '', 'g'), '::[A-Za-z_][A-Za-z0-9_.]*(\[\])?', '', 'g'), '\s+', ' ', 'g'), ' ;') as def
  from v
),
cols as (
  select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) as list
  from information_schema.columns where table_schema = 'public' and table_name = 'public_artists'
),
-- Every privilege on the view and on its columns: (grantee, grantor, privilege, level). grantee 0 = PUBLIC.
acl as (
  select a.grantee, a.grantor, a.privilege_type, 'table' as level
  from v, aclexplode(v.relacl) a
  union all
  select a.grantee, a.grantor, a.privilege_type, 'column ' || att.attname
  from v join pg_attribute att on att.attrelid = v.oid and att.attnum > 0 and att.attacl is not null,
       aclexplode(att.attacl) a
),
writes as (
  select * from acl where privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
),
api_writes as (
  select r.rolname as role, p as privilege
  from pg_roles r, v,
       unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
  where r.rolname in ('anon', 'authenticated')
    and case when p in ('INSERT', 'UPDATE', 'REFERENCES') then has_any_column_privilege(r.oid, v.oid, p)
             else has_table_privilege(r.oid, v.oid, p) end
),
checks(ord, area, check_name, result, expected, ok) as (
  select 1, 'baseline', '0042 applied (public_artists.name is the public display name)',
    coalesce((select strpos(def, 'COALESCE(NULLIF(btrim(stage_name), ''''), name) AS name') > 0 from vdef), false)::text, 'true',
    coalesce((select strpos(def, 'COALESCE(NULLIF(btrim(stage_name), ''''), name) AS name') > 0 from vdef), false)
  union all
  select 2, 'baseline', '0043 / 0044 status (informational; 0045 does not depend on them)',
    concat_ws('; ',
      '0043 ' || case when to_regprocedure('public.set_programme_sessions(uuid,uuid[])') is not null then 'applied' else 'not applied' end,
      '0044 ' || case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'join_waitlist'
                                     and strpos(prosrc, 'event_booking_closed(') > 0) then 'applied' else 'not applied' end),
    'either', true
  union all
  select 3, 'baseline', '0045 not yet applied (anon/authenticated still hold write privileges)',
    (exists (select 1 from api_writes))::text, 'true',
    exists (select 1 from api_writes)
  union all
  select 4, 'view', 'public_artists exists and is a plain view (no security_invoker / security_barrier / check option)',
    coalesce((select concat_ws('; ', 'relkind ' || relkind::text, 'options ' || coalesce(array_to_string(reloptions, ','), '-')) from v), 'missing'),
    'relkind v; options -',
    coalesce((select relkind = 'v' and reloptions is null from v), false)
  union all
  select 5, 'view', 'public_artists definition is the 0042 version (normalized)',
    coalesce((select case when def = 'SELECT id, COALESCE(NULLIF(btrim(stage_name), ''''), name) AS name, stage_name, genre, subgenre, city, bio, avatar_url, instagram, soundcloud, spotify, youtube, performance_type, applied_at, slug, cover_url, long_bio, country, languages, instruments, genres, years_active, website, highlights FROM artists WHERE (status = ''approved'')'
                          then 'same as 0042' else def end from vdef), 'missing'),
    'same as 0042',
    coalesce((select def = 'SELECT id, COALESCE(NULLIF(btrim(stage_name), ''''), name) AS name, stage_name, genre, subgenre, city, bio, avatar_url, instagram, soundcloud, spotify, youtube, performance_type, applied_at, slug, cover_url, long_bio, country, languages, instruments, genres, years_active, website, highlights FROM artists WHERE (status = ''approved'')' from vdef), false)
  union all
  select 6, 'view', 'public_artists columns and types',
    coalesce((select list from cols), 'missing'),
    'id:uuid,name:text,stage_name:text,genre:text,subgenre:text,city:text,bio:text,avatar_url:text,instagram:text,soundcloud:text,spotify:text,youtube:text,performance_type:text,applied_at:timestamp with time zone,slug:text,cover_url:text,long_bio:text,country:text,languages:ARRAY,instruments:ARRAY,genres:ARRAY,years_active:integer,website:text,highlights:text',
    coalesce((select list from cols), '') = 'id:uuid,name:text,stage_name:text,genre:text,subgenre:text,city:text,bio:text,avatar_url:text,instagram:text,soundcloud:text,spotify:text,youtube:text,performance_type:text,applied_at:timestamp with time zone,slug:text,cover_url:text,long_bio:text,country:text,languages:ARRAY,instruments:ARRAY,genres:ARRAY,years_active:integer,website:text,highlights:text'
  union all
  select 7, 'view', 'no extra rules, triggers or dependent views on public_artists',
    coalesce((select concat_ws('; ',
       'rules ' || (select count(*) from pg_rewrite where ev_class = v.oid and rulename <> '_RETURN'),
       'triggers ' || (select count(*) from pg_trigger where tgrelid = v.oid),
       'dependent views ' || (select count(*) from pg_depend d join pg_rewrite r on r.oid = d.objid
                               where d.refobjid = v.oid and r.ev_class <> v.oid)) from v), 'missing'),
    'rules 0; triggers 0; dependent views 0',
    coalesce((select (select count(*) from pg_rewrite where ev_class = v.oid and rulename <> '_RETURN') = 0
                 and (select count(*) from pg_trigger where tgrelid = v.oid) = 0
                 and (select count(*) from pg_depend d join pg_rewrite r on r.oid = d.objid
                       where d.refobjid = v.oid and r.ev_class <> v.oid) = 0 from v), false)
  union all
  select 8, 'grants', 'anon and authenticated can SELECT public_artists (must stay)',
    coalesce((select concat_ws('; ', 'anon ' || has_table_privilege('anon', oid, 'SELECT')::text,
                                     'authenticated ' || has_table_privilege('authenticated', oid, 'SELECT')::text) from v), 'missing'),
    'anon true; authenticated true',
    coalesce((select has_table_privilege('anon', oid, 'SELECT') and has_table_privilege('authenticated', oid, 'SELECT') from v), false)
  union all
  select 9, 'SECURITY', 'CURRENT write privileges of anon / authenticated = exactly the pre-0045 set 0045 removes',
    coalesce((select string_agg(role || ' ' || privs, '; ' order by role) from (
       select role, string_agg(privilege, ',' order by privilege) privs from api_writes group by role) x), 'none'),
    'anon DELETE,INSERT,REFERENCES,TRIGGER,TRUNCATE,UPDATE; authenticated DELETE,INSERT,REFERENCES,TRIGGER,TRUNCATE,UPDATE',
    coalesce((select string_agg(role || ' ' || privs, '; ' order by role) from (
       select role, string_agg(privilege, ',' order by privilege) privs from api_writes group by role) x), 'none')
      = 'anon DELETE,INSERT,REFERENCES,TRIGGER,TRUNCATE,UPDATE; authenticated DELETE,INSERT,REFERENCES,TRIGGER,TRUNCATE,UPDATE'
  union all
  select 10, 'grants', 'every anon/authenticated write grant was made by the view owner (REVOKE will remove it)',
    coalesce((select string_agg(distinct pg_get_userbyid(w.grantee) || ' ' || w.privilege_type || ' (' || w.level || ') granted by ' || pg_get_userbyid(w.grantor), '; ')
       from writes w, v where w.grantee in ('anon'::regrole, 'authenticated'::regrole) and w.grantor <> v.relowner), '(all by the owner)'),
    '(all by the owner)',
    not exists (select 1 from writes w, v where w.grantee in ('anon'::regrole, 'authenticated'::regrole) and w.grantor <> v.relowner)
  union all
  select 11, 'grants', 'PUBLIC holds no write privilege on public_artists (it would pass to anon)',
    coalesce((select string_agg(privilege_type || ' (' || level || ')', ', ') from writes where grantee = 0), 'none'),
    'none',
    not exists (select 1 from writes where grantee = 0)
  union all
  select 12, 'grants', 'anon / authenticated inherit no write privilege through any role membership (direct or indirect)',
    coalesce((select string_agg(distinct r.rolname || ' is a member of ' || pg_get_userbyid(w.grantee) || ' (' || w.privilege_type || ')', '; ')
       from pg_roles r, writes w
       where r.rolname in ('anon', 'authenticated') and w.grantee <> 0 and w.grantee <> r.oid
         and pg_has_role(r.oid, w.grantee, 'MEMBER')), 'none'),
    'none',
    not exists (select 1 from pg_roles r, writes w
                where r.rolname in ('anon', 'authenticated') and w.grantee <> 0 and w.grantee <> r.oid
                  and pg_has_role(r.oid, w.grantee, 'MEMBER'))
  union all
  select 13, 'grants', 'the current user can revoke as the view owner',
    coalesce((select 'owner ' || pg_get_userbyid(relowner) || '; current_user ' || current_user || '; can act as owner: ' || pg_has_role(current_user, relowner, 'MEMBER')::text from v), 'missing'),
    'can act as owner: true',
    coalesce((select pg_has_role(current_user, relowner, 'MEMBER') from v), false)
  union all
  select 14, 'grants', 'service_role privileges on public_artists (informational; 0045 leaves them unchanged)',
    coalesce((select string_agg(p, ',' order by p) from v, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
               where has_table_privilege('service_role', v.oid, p)), 'none'),
    'DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE', true
  union all
  select 15, 'grants', 'MAINTAIN privileges (PostgreSQL 17+ only; informational; 0045 leaves them unchanged)',
    coalesce((select string_agg(distinct case when grantee = 0 then 'PUBLIC' else pg_get_userbyid(grantee) end, ', ') from acl where privilege_type = 'MAINTAIN'), 'none')
      || ' (server ' || current_setting('server_version') || ')',
    'any', true
  union all
  select 16, 'grants', 'every OTHER grantee (informational: post-check row 15 must show exactly the same)',
    coalesce((select string_agg(g || '=' || privs, '; ' order by g) from (
       select case when grantee = 0 then 'PUBLIC' else pg_get_userbyid(grantee) end g, string_agg(privilege_type, ',' order by privilege_type) privs
       from v, aclexplode(v.relacl) x where grantee not in ('anon'::regrole, 'authenticated'::regrole) group by grantee) a), 'none'),
    'reported', true
)
select ord, area, check_name, result, expected, ok
from checks
union all
select 99, 'verdict', 'VERDICT',
  case when bool_and(ok) then 'ALL CHECKS PASSED — safe to apply 0045' else 'STOP — at least one check failed' end,
  'ALL CHECKS PASSED — safe to apply 0045', bool_and(ok)
from checks
order by ord;
