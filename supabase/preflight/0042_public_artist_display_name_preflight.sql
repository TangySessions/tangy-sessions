-- READ-ONLY preflight for 0042_public_artist_display_name.sql — ONE SELECT statement.
-- Reads catalogs and counts rows; changes nothing. Every row must show ok = true.
-- Rows 9–11 are informational (always ok).
with
v as (select c.oid, c.relkind, c.relowner, c.reloptions from pg_class c where c.oid = to_regclass('public.public_artists')),
vdef as (
  select btrim(regexp_replace(regexp_replace(regexp_replace(replace(pg_get_viewdef(v.oid), '"', ''), '\m(public|artists|objects)\.', '', 'g'), '::[A-Za-z_][A-Za-z0-9_.]*(\[\])?', '', 'g'), '\s+', ' ', 'g'), ' ;') as def
  from v
),
cols as (
  select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) as list
  from information_schema.columns where table_schema = 'public' and table_name = 'public_artists'
),
checks(ord, area, check_name, result, expected, ok) as (
  select 1, 'baseline', '0041 applied (has_open_artist_application + the three new storage policies)',
    (to_regprocedure('public.has_open_artist_application()') is not null
     and (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
            and ((policyname = 'sponsor-assets: delete' and strpos(qual, 'sponsor_assets') > 0)
              or (policyname = 'artist-media: applicant upload' and strpos(with_check, 'has_open_artist_application') > 0)
              or (policyname = 'artist-media: applicant delete' and strpos(qual, 'has_open_artist_application') > 0))) = 3)::text,
    'true',
    to_regprocedure('public.has_open_artist_application()') is not null
     and (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
            and ((policyname = 'sponsor-assets: delete' and strpos(qual, 'sponsor_assets') > 0)
              or (policyname = 'artist-media: applicant upload' and strpos(with_check, 'has_open_artist_application') > 0)
              or (policyname = 'artist-media: applicant delete' and strpos(qual, 'has_open_artist_application') > 0))) = 3
  union all
  select 2, 'baseline', '0042 not yet applied (view name column is still artists.name)',
    (not exists (select 1 from vdef where strpos(def, 'COALESCE(NULLIF(btrim(stage_name), ''''), name) AS name') > 0))::text, 'true',
    not exists (select 1 from vdef where strpos(def, 'COALESCE(NULLIF(btrim(stage_name), ''''), name) AS name') > 0)
  union all
  select 3, 'baseline', '0043–0044 not yet applied',
    concat_ws(', ',
      case when to_regprocedure('public.set_programme_sessions(uuid,uuid[])') is not null then '0043' end,
      case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('join_waitlist', 'offer_waitlist_seats')
                          and strpos(prosrc, 'event_booking_closed(v_event.event_date, v_event.timezone, v_event.status)') > 0) then '0044' end),
    '(empty)',
    to_regprocedure('public.set_programme_sessions(uuid,uuid[])') is null
      and not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('join_waitlist', 'offer_waitlist_seats')
                        and strpos(prosrc, 'event_booking_closed(v_event.event_date, v_event.timezone, v_event.status)') > 0)
  union all
  select 4, 'view', 'public_artists is a plain view, no options, replaceable by the current user',
    coalesce((select concat_ws('; ', 'relkind ' || relkind::text, 'options ' || coalesce(array_to_string(reloptions, ','), '-'),
                               'owner ' || pg_get_userbyid(relowner), 'current_user can replace: ' || pg_has_role(current_user, relowner, 'MEMBER')::text) from v), 'missing'),
    'relkind v; options -; owner …; current_user can replace: true',
    coalesce((select relkind = 'v' and reloptions is null and pg_has_role(current_user, relowner, 'MEMBER') from v), false)
  union all
  select 5, 'view', 'public_artists columns and types (0042 keeps them exactly)',
    coalesce((select list from cols), 'missing'),
    'id:uuid,name:text,stage_name:text,genre:text,subgenre:text,city:text,bio:text,avatar_url:text,instagram:text,soundcloud:text,spotify:text,youtube:text,performance_type:text,applied_at:timestamp with time zone,slug:text,cover_url:text,long_bio:text,country:text,languages:ARRAY,instruments:ARRAY,genres:ARRAY,years_active:integer,website:text,highlights:text',
    coalesce((select list from cols), '') = 'id:uuid,name:text,stage_name:text,genre:text,subgenre:text,city:text,bio:text,avatar_url:text,instagram:text,soundcloud:text,spotify:text,youtube:text,performance_type:text,applied_at:timestamp with time zone,slug:text,cover_url:text,long_bio:text,country:text,languages:ARRAY,instruments:ARRAY,genres:ARRAY,years_active:integer,website:text,highlights:text'
  union all
  select 6, 'drift', 'public_artists definition unchanged since 0036 (normalized)',
    coalesce((select case when def = 'SELECT id, name, stage_name, genre, subgenre, city, bio, avatar_url, instagram, soundcloud, spotify, youtube, performance_type, applied_at, slug, cover_url, long_bio, country, languages, instruments, genres, years_active, website, highlights FROM artists WHERE (status = ''approved'')'
                          then 'same as 0036' else def end from vdef), 'missing'),
    'same as 0036',
    coalesce((select def = 'SELECT id, name, stage_name, genre, subgenre, city, bio, avatar_url, instagram, soundcloud, spotify, youtube, performance_type, applied_at, slug, cover_url, long_bio, country, languages, instruments, genres, years_active, website, highlights FROM artists WHERE (status = ''approved'')' from vdef), false)
  union all
  select 7, 'dependencies', 'artists.name and artists.stage_name are text (new name column stays text)',
    coalesce((select string_agg(column_name || ':' || data_type, ',' order by column_name) from information_schema.columns
               where table_schema = 'public' and table_name = 'artists' and column_name in ('name', 'stage_name')), 'missing'),
    'name:text,stage_name:text',
    coalesce((select string_agg(column_name || ':' || data_type, ',' order by column_name) from information_schema.columns
               where table_schema = 'public' and table_name = 'artists' and column_name in ('name', 'stage_name')), '') = 'name:text,stage_name:text'
  union all
  select 8, 'grants', 'anon and authenticated can read public_artists (as today)',
    coalesce((select concat_ws('; ', 'anon ' || has_table_privilege('anon', oid, 'SELECT')::text,
                                     'authenticated ' || has_table_privilege('authenticated', oid, 'SELECT')::text) from v), 'missing'),
    'anon true; authenticated true',
    coalesce((select has_table_privilege('anon', oid, 'SELECT') and has_table_privilege('authenticated', oid, 'SELECT') from v), false)
  union all
  select 9, 'impact', 'approved artists whose public name changes to their stage name (informational)',
    (select count(*) from artists where status = 'approved'::application_status
       and nullif(btrim(stage_name), '') is not null and btrim(stage_name) is distinct from name)::text,
    'any (0 on an empty database)', true
  union all
  select 10, 'impact', 'other views/rules that depend on public_artists (informational; expected 0)',
    (select count(*) from pg_depend d join pg_rewrite r on r.oid = d.objid
       where d.refobjid = to_regclass('public.public_artists') and r.ev_class <> to_regclass('public.public_artists'))::text,
    '0', true
  union all
  select 11, 'security', 'write privileges on public_artists (PRE-EXISTING; not changed by 0042; informational)',
    coalesce((select concat_ws('; ',
       'anon ' || coalesce(nullif(concat_ws(',', case when has_table_privilege('anon', oid, 'INSERT') then 'INSERT' end,
                                                case when has_table_privilege('anon', oid, 'UPDATE') then 'UPDATE' end,
                                                case when has_table_privilege('anon', oid, 'DELETE') then 'DELETE' end), ''), 'none'),
       'authenticated ' || coalesce(nullif(concat_ws(',', case when has_table_privilege('authenticated', oid, 'INSERT') then 'INSERT' end,
                                                         case when has_table_privilege('authenticated', oid, 'UPDATE') then 'UPDATE' end,
                                                         case when has_table_privilege('authenticated', oid, 'DELETE') then 'DELETE' end), ''), 'none')) from v), 'missing'),
    'should be: anon none; authenticated none', true
)
select ord, area, check_name, result, expected, ok,
       case when bool_and(ok) over () then 'ALL CHECKS PASSED — safe to apply 0042' else 'STOP — at least one check failed' end as verdict
from checks
order by ord;
