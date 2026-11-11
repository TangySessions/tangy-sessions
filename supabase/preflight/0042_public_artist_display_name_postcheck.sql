-- READ-ONLY check after applying 0042 — ONE SELECT statement.
select 1 as ord, '0042 applied: name is the public display name' as check_name,
       (strpos(pg_get_viewdef(to_regclass('public.public_artists')), 'COALESCE(NULLIF(btrim(') > 0)::text as result, 'true' as expected,
       coalesce(strpos(pg_get_viewdef(to_regclass('public.public_artists')), 'COALESCE(NULLIF(btrim(') > 0, false) as ok
union all
select 2, 'columns unchanged (24, same order)',
       (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'public_artists'),
       'id,name,stage_name,genre,subgenre,city,bio,avatar_url,instagram,soundcloud,spotify,youtube,performance_type,applied_at,slug,cover_url,long_bio,country,languages,instruments,genres,years_active,website,highlights',
       coalesce((select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'public_artists')
         = 'id,name,stage_name,genre,subgenre,city,bio,avatar_url,instagram,soundcloud,spotify,youtube,performance_type,applied_at,slug,cover_url,long_bio,country,languages,instruments,genres,years_active,website,highlights', false)
union all
select 3, 'anon and authenticated can still read it',
       (has_table_privilege('anon', 'public.public_artists', 'SELECT') and has_table_privilege('authenticated', 'public.public_artists', 'SELECT'))::text, 'true',
       has_table_privilege('anon', 'public.public_artists', 'SELECT') and has_table_privilege('authenticated', 'public.public_artists', 'SELECT')
union all
select 4, 'legal name no longer exposed for approved artists with a stage name',
       (select count(*) from public_artists p join artists a on a.id = p.id
         where nullif(btrim(a.stage_name), '') is not null and p.name is distinct from btrim(a.stage_name))::text, '0',
       not exists (select 1 from public_artists p join artists a on a.id = p.id
         where nullif(btrim(a.stage_name), '') is not null and p.name is distinct from btrim(a.stage_name))
order by ord;
