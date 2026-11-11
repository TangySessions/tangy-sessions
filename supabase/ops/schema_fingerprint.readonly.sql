-- READ-ONLY schema fingerprint for TangySessions. ONE SELECT statement: it
-- reads system catalogs only. It cannot write, create, alter or drop anything,
-- reads no table rows and returns no personal data, secrets or cron commands.
--
-- Purpose: prove that a database's schema matches the repository's migration
-- history object by object, before any Edge Function is deployed against it.
--   1. Run it on a fresh local database built from supabase/migrations:
--      scripts/test-fresh-db.sh, then scripts/schema-fingerprint.sh > expected.csv
--   2. Run it on production in the SQL editor (optionally inside
--      `begin transaction read only; … rollback;`) and download the result as
--      CSV.
--   3. node scripts/compare-schema-fingerprint.mjs <expected.csv> <production.csv>
--
-- Each row: kind | name | fingerprint (md5 of the definition). Function
-- fingerprints hash the stored source text, arguments, return type, security
-- mode and settings, so they don't depend on the server's pretty-printer;
-- view, trigger and index definitions use pg_get_*def, which can differ
-- cosmetically between PostgreSQL major versions (compare.mjs reports those
-- separately). Supabase-managed schemas are excluded except storage policies.
with
fns as (
  select 'function' as kind,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as name,
         md5(concat_ws('|', p.prosrc, pg_get_function_result(p.oid), p.prosecdef::text,
                       p.provolatile::text, coalesce(array_to_string(p.proconfig, ','), ''),
                       l.lanname)) as fingerprint
    from pg_proc p
    join pg_language l on l.oid = p.prolang
   where p.pronamespace = 'public'::regnamespace
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
),
trg as (
  select 'trigger', c.relname || '.' || t.tgname, md5(pg_get_triggerdef(t.oid))
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where not t.tgisinternal and c.relnamespace in ('public'::regnamespace)
),
pol as (
  select 'policy', schemaname || '.' || tablename || ': ' || policyname,
         md5(concat_ws('|', permissive, array_to_string(roles, ','), cmd, coalesce(qual, ''), coalesce(with_check, '')))
    from pg_policies
   where schemaname in ('public', 'storage')
),
vw as (
  select 'view', c.relname, md5(pg_get_viewdef(c.oid))
    from pg_class c where c.relkind in ('v', 'm') and c.relnamespace = 'public'::regnamespace
),
idx as (
  select 'index', i.indexname, md5(i.indexdef)
    from pg_indexes i where i.schemaname = 'public'
),
col as (
  select 'table', c.relname,
         md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text
                        || ':' || coalesce(pg_get_expr(ad.adbin, ad.adrelid), ''), ',' order by a.attname))
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef ad on ad.adrelid = c.oid and ad.adnum = a.attnum
   where c.relkind in ('r', 'p') and c.relnamespace = 'public'::regnamespace
   group by c.relname
),
rls as (
  select 'rls', c.relname, md5(c.relrowsecurity::text || ':' || c.relforcerowsecurity::text)
    from pg_class c where c.relkind in ('r', 'p') and c.relnamespace = 'public'::regnamespace
),
enm as (
  select 'enum', t.typname, md5(string_agg(e.enumlabel, ',' order by e.enumsortorder))
    from pg_type t join pg_enum e on e.enumtypid = t.oid
   where t.typnamespace = 'public'::regnamespace group by t.typname
),
grants as (
  -- Table privileges for the API roles (0045 depends on these).
  select 'grant', c.relname || ' to ' || r.rolname,
         md5(concat_ws(',',
           case when has_table_privilege(r.oid, c.oid, 'SELECT') then 'S' end,
           case when has_table_privilege(r.oid, c.oid, 'INSERT') then 'I' end,
           case when has_table_privilege(r.oid, c.oid, 'UPDATE') then 'U' end,
           case when has_table_privilege(r.oid, c.oid, 'DELETE') then 'D' end))
    from pg_class c cross join pg_roles r
   where c.relkind in ('r', 'p', 'v', 'm') and c.relnamespace = 'public'::regnamespace
     and r.rolname in ('anon', 'authenticated')
),
buckets as (
  select 'bucket', b.id, md5(concat_ws('|', b.public::text, coalesce(b.file_size_limit::text, ''), coalesce(array_to_string(b.allowed_mime_types, ','), '')))
    from storage.buckets b
),
allrows as (
  select * from fns union all select * from trg union all select * from pol
  union all select * from vw union all select * from idx union all select * from col
  union all select * from rls union all select * from enm union all select * from grants
  union all select * from buckets
)
select kind, name, fingerprint from allrows
union all
select 'summary', 'all objects (' || count(*) || ')', md5(string_agg(kind || '|' || name || '|' || fingerprint, ';' order by kind, name)) from allrows
order by 1, 2;
