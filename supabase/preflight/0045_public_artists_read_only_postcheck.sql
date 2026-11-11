-- READ-ONLY check AFTER applying 0045_public_artists_read_only.sql — ONE
-- SELECT statement; it cannot change anything. Every row must show
-- ok = true; the last row is the verdict.
--
-- Effective privileges are checked with has_table_privilege /
-- has_any_column_privilege, so grants through PUBLIC, role membership or
-- column-level grants are all counted.
with
v as (
  select c.oid, c.relkind, c.reloptions, c.relacl
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
-- Effective privilege of a role (INSERT / UPDATE / REFERENCES also count column-level grants).
priv(role, privilege, has) as (
  select r, p, case when p in ('INSERT', 'UPDATE', 'REFERENCES') then has_any_column_privilege(r, v.oid, p)
                    else has_table_privilege(r, v.oid, p) end
  from v, unnest(array['anon', 'authenticated', 'service_role']) r,
       unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
),
expected_priv(ord, role, privilege, want) as (values
  (1, 'anon', 'SELECT', true), (2, 'authenticated', 'SELECT', true),
  (3, 'anon', 'INSERT', false), (4, 'anon', 'UPDATE', false), (5, 'anon', 'DELETE', false),
  (6, 'authenticated', 'INSERT', false), (7, 'authenticated', 'UPDATE', false), (8, 'authenticated', 'DELETE', false)
),
checks(ord, area, check_name, result, expected, ok) as (
  select e.ord, 'privileges', e.role || ' ' || e.privilege,
    coalesce(p.has::text, 'missing'), e.want::text, coalesce(p.has = e.want, false)
  from expected_priv e
  left join priv p on p.role = e.role and p.privilege = e.privilege
  union all
  select 9, 'privileges', 'anon / authenticated TRUNCATE, REFERENCES, TRIGGER',
    coalesce((select string_agg(role || ' ' || privilege, ', ' order by role, privilege) from priv
               where role in ('anon', 'authenticated') and privilege in ('TRUNCATE', 'REFERENCES', 'TRIGGER') and has), 'none'),
    'none',
    exists (select 1 from v) and not exists (select 1 from priv where role in ('anon', 'authenticated') and privilege in ('TRUNCATE', 'REFERENCES', 'TRIGGER') and has)
  union all
  select 10, 'privileges', 'service_role keeps every privilege (not removed)',
    coalesce((select string_agg(privilege, ',' order by privilege) from priv where role = 'service_role' and has), 'none'),
    'DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE',
    coalesce((select string_agg(privilege, ',' order by privilege) from priv where role = 'service_role' and has), '') = 'DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'
  union all
  select 11, 'privileges', 'the view owner keeps every privilege (not removed)',
    coalesce((select string_agg(p, ',' order by p) from v, pg_class c, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
               where c.oid = v.oid and has_table_privilege(c.relowner, v.oid, p)), 'none'),
    'DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE',
    coalesce((select string_agg(p, ',' order by p) from v, pg_class c, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
               where c.oid = v.oid and has_table_privilege(c.relowner, v.oid, p)), '') = 'DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'
  union all
  select 12, 'privileges', 'anon / authenticated hold exactly SELECT (table level), nothing per column',
    coalesce((select string_agg(pg_get_userbyid(grantee) || '=' || privs, '; ' order by 1) from (
       select grantee, string_agg(privilege_type, ',' order by privilege_type) privs
       from v, aclexplode(v.relacl) x where grantee in ('anon'::regrole, 'authenticated'::regrole) and privilege_type <> 'MAINTAIN' group by grantee) a), 'none')
      || '; column grants ' || coalesce((select count(*) from v, pg_attribute att, aclexplode(att.attacl) x
            where att.attrelid = v.oid and att.attacl is not null and x.grantee in ('anon'::regrole, 'authenticated'::regrole))::text, '0'),
    'anon=SELECT; authenticated=SELECT; column grants 0',
    coalesce((select string_agg(pg_get_userbyid(grantee) || '=' || privs, '; ' order by 1) from (
       select grantee, string_agg(privilege_type, ',' order by privilege_type) privs
       from v, aclexplode(v.relacl) x where grantee in ('anon'::regrole, 'authenticated'::regrole) and privilege_type <> 'MAINTAIN' group by grantee) a), '')
      || '; column grants ' || coalesce((select count(*) from v, pg_attribute att, aclexplode(att.attacl) x
            where att.attrelid = v.oid and att.attacl is not null and x.grantee in ('anon'::regrole, 'authenticated'::regrole))::text, '0')
      = 'anon=SELECT; authenticated=SELECT; column grants 0'
  union all
  select 15, 'privileges', 'every OTHER grantee (informational: must equal preflight row 16 — 0045 touches only anon / authenticated)',
    coalesce((select string_agg(g || '=' || privs, '; ' order by g) from (
       select case when grantee = 0 then 'PUBLIC' else pg_get_userbyid(grantee) end g, string_agg(privilege_type, ',' order by privilege_type) privs
       from v, aclexplode(v.relacl) x where grantee not in ('anon'::regrole, 'authenticated'::regrole) group by grantee) a), 'none'),
    'same as preflight row 16', true
  union all
  select 13, 'view', 'public_artists is still a plain view, definition unchanged (0042 version, normalized)',
    coalesce((select case when v.relkind = 'v' and v.reloptions is null
                            and def = 'SELECT id, COALESCE(NULLIF(btrim(stage_name), ''''), name) AS name, stage_name, genre, subgenre, city, bio, avatar_url, instagram, soundcloud, spotify, youtube, performance_type, applied_at, slug, cover_url, long_bio, country, languages, instruments, genres, years_active, website, highlights FROM artists WHERE (status = ''approved'')'
                          then 'same as 0042' else 'relkind ' || v.relkind::text || '; options ' || coalesce(array_to_string(v.reloptions, ','), '-') || '; ' || def end
              from v, vdef), 'missing'),
    'same as 0042',
    coalesce((select v.relkind = 'v' and v.reloptions is null
                     and def = 'SELECT id, COALESCE(NULLIF(btrim(stage_name), ''''), name) AS name, stage_name, genre, subgenre, city, bio, avatar_url, instagram, soundcloud, spotify, youtube, performance_type, applied_at, slug, cover_url, long_bio, country, languages, instruments, genres, years_active, website, highlights FROM artists WHERE (status = ''approved'')'
              from v, vdef), false)
  union all
  select 14, 'view', 'public_artists columns and types unchanged',
    coalesce((select list from cols), 'missing'),
    'id:uuid,name:text,stage_name:text,genre:text,subgenre:text,city:text,bio:text,avatar_url:text,instagram:text,soundcloud:text,spotify:text,youtube:text,performance_type:text,applied_at:timestamp with time zone,slug:text,cover_url:text,long_bio:text,country:text,languages:ARRAY,instruments:ARRAY,genres:ARRAY,years_active:integer,website:text,highlights:text',
    coalesce((select list from cols), '') = 'id:uuid,name:text,stage_name:text,genre:text,subgenre:text,city:text,bio:text,avatar_url:text,instagram:text,soundcloud:text,spotify:text,youtube:text,performance_type:text,applied_at:timestamp with time zone,slug:text,cover_url:text,long_bio:text,country:text,languages:ARRAY,instruments:ARRAY,genres:ARRAY,years_active:integer,website:text,highlights:text'
)
select ord, area, check_name, result, expected, ok
from checks
union all
select 99, 'verdict', 'VERDICT',
  case when bool_and(ok) then 'ALL CHECKS PASSED — public_artists is read-only for anon / authenticated' else 'STOP — at least one check failed' end,
  'ALL CHECKS PASSED — public_artists is read-only for anon / authenticated', bool_and(ok)
from checks
order by ord;
