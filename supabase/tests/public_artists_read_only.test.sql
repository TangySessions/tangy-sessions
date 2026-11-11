-- Tangy Sessions — the public artist directory is read-only for the API roles (0045).
--
-- Every statement below runs the way the API runs it: as anon or as a
-- signed-in user (role + JWT claims), exactly what GET / PATCH / DELETE /
-- POST /rest/v1/public_artists would do.
-- Test-owned rows only; one transaction, rolled back.
-- Run: scripts/test-db.sh / scripts/test-db-local.sh

\set ON_ERROR_STOP 1
\set QUIET 1
begin;

create schema tt;
create function tt.check(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL [%]', p_label; end if;
  raise notice 'ok  %', p_label;
end $$;
-- The error a statement raises (null if it succeeded).
create function tt.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function tt.anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
end $$;
create function tt.login(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function tt.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;
create function tt.logout() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
-- The artist row as the table owner sees it (bypasses RLS) — the ground truth.
create function tt.a(p_id uuid) returns artists language sql security definer set search_path = public as $$
  select * from artists where id = p_id;
$$;
-- Effective privilege (INSERT / UPDATE / REFERENCES also count column-level grants).
create function tt.can(p_role text, p_priv text) returns boolean language sql stable as $$
  select case when p_priv in ('INSERT', 'UPDATE', 'REFERENCES') then has_any_column_privilege(p_role, 'public.public_artists', p_priv)
              else has_table_privilege(p_role, 'public.public_artists', p_priv) end;
$$;
grant usage on schema tt to anon, authenticated, service_role;
grant execute on all functions in schema tt to anon, authenticated, service_role;

insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000ab501', 'test-artist@readonly.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Legal Name"}'),
  ('00000000-0000-0000-0000-0000000ab502', 'test-other@readonly.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Other"}');
insert into artists (id, user_id, name, stage_name, email, genre, bio, status) values
  ('00000000-0000-0000-0000-0000000ab5a1', '00000000-0000-0000-0000-0000000ab501', 'Test Legal Name', 'Test Stage', 'test-artist@readonly.tangy.test', 'house', 'Original bio.', 'approved');

\echo '--- 1. privileges on the view'
select tt.check(tt.can('anon', 'SELECT') and tt.can('authenticated', 'SELECT'), 'anon and authenticated keep SELECT');
select tt.check(not tt.can('anon', p) and not tt.can('authenticated', p), 'anon and authenticated have no ' || p)
  from unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p;
select tt.check(not exists (select 1 from pg_attribute att, aclexplode(att.attacl) x
                            where att.attrelid = 'public.public_artists'::regclass and att.attacl is not null
                              and x.grantee in ('anon'::regrole, 'authenticated'::regrole)), 'no column-level grants to anon / authenticated');
select tt.check(tt.can('service_role', p), 'service_role keeps ' || p)
  from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p;

\echo '--- 2. anonymous visitors: read yes, write no'
select tt.anon();
select tt.check((select name = 'Test Stage' and bio = 'Original bio.' from public_artists where id = '00000000-0000-0000-0000-0000000ab5a1'), 'anon reads the directory (public name)');
select tt.check(tt.err($$update public_artists set bio = 'defaced' where id = '00000000-0000-0000-0000-0000000ab5a1'$$) like '42501%permission denied%public_artists%', 'anon UPDATE refused (42501)');
select tt.check(tt.err($$delete from public_artists where id = '00000000-0000-0000-0000-0000000ab5a1'$$) like '42501%permission denied%public_artists%', 'anon DELETE refused (42501)');
select tt.check(tt.err($$insert into public_artists (id, stage_name) values ('00000000-0000-0000-0000-0000000ab5f1', 'Spam')$$) like '42501%permission denied%public_artists%', 'anon INSERT refused (42501)');
select tt.check(tt.err($$truncate public_artists$$) is not null, 'anon TRUNCATE fails (a view cannot be truncated; the privilege is gone too, section 1)');
select tt.logout();
select tt.check((tt.a('00000000-0000-0000-0000-0000000ab5a1')).bio = 'Original bio.', 'the artist row is untouched');

\echo '--- 3. signed-in users (another user and the artist themself): read yes, write through the view no'
select tt.login('00000000-0000-0000-0000-0000000ab502');
select tt.check(exists (select 1 from public_artists where id = '00000000-0000-0000-0000-0000000ab5a1'), 'a signed-in user reads the directory');
select tt.check(tt.err($$update public_artists set bio = 'defaced' where id = '00000000-0000-0000-0000-0000000ab5a1'$$) like '42501%permission denied%public_artists%', 'another user: UPDATE refused (42501)');
select tt.check(tt.err($$delete from public_artists where id = '00000000-0000-0000-0000-0000000ab5a1'$$) like '42501%permission denied%public_artists%', 'another user: DELETE refused (42501)');
select tt.check(tt.err($$insert into public_artists (id, stage_name) values ('00000000-0000-0000-0000-0000000ab5f2', 'Spam')$$) like '42501%permission denied%public_artists%', 'another user: INSERT refused (42501)');
select tt.login('00000000-0000-0000-0000-0000000ab501');
select tt.check(tt.err($$update public_artists set bio = 'via view' where id = '00000000-0000-0000-0000-0000000ab5a1'$$) like '42501%permission denied%public_artists%', 'the artist: UPDATE through the view refused (42501)');
select tt.check(tt.err($$delete from public_artists where id = '00000000-0000-0000-0000-0000000ab5a1'$$) like '42501%permission denied%public_artists%', 'the artist: DELETE through the view refused (42501)');
select tt.logout();
select tt.check((tt.a('00000000-0000-0000-0000-0000000ab5a1')).bio = 'Original bio.', 'the artist row is still untouched');

\echo '--- 4. the real edit paths are unchanged'
select tt.login('00000000-0000-0000-0000-0000000ab501');
update artists set bio = 'Edited on my profile.' where id = '00000000-0000-0000-0000-0000000ab5a1';
select tt.logout();
select tt.check((tt.a('00000000-0000-0000-0000-0000000ab5a1')).bio = 'Edited on my profile.', 'the artist still edits their own profile on artists (RLS + 0040, unchanged)');
select tt.anon();
select tt.check((select bio = 'Edited on my profile.' from public_artists where id = '00000000-0000-0000-0000-0000000ab5a1'), '...and the directory shows it');
select tt.check(not exists (select 1 from artists where id = '00000000-0000-0000-0000-0000000ab5a1'), 'anon still cannot read the artists table (RLS unchanged)');
select tt.as_service();
update public_artists set bio = 'Set by the server.' where id = '00000000-0000-0000-0000-0000000ab5a1';
select tt.check((select bio = 'Set by the server.' from public_artists where id = '00000000-0000-0000-0000-0000000ab5a1'), 'service_role (server side) is not broken: it can still read and write');
select tt.logout();

\echo '--- 5. view unchanged; re-running the revoke is a no-op'
select tt.check((select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'public_artists')
  = 'id,name,stage_name,genre,subgenre,city,bio,avatar_url,instagram,soundcloud,spotify,youtube,performance_type,applied_at,slug,cover_url,long_bio,country,languages,instruments,genres,years_active,website,highlights', 'the 24 view columns are unchanged');
select tt.check(pg_get_viewdef('public.public_artists'::regclass) like '%COALESCE(NULLIF(btrim(stage_name)%'
  and (select relkind = 'v' and reloptions is null from pg_class where oid = 'public.public_artists'::regclass), 'the view definition is the 0042 one, still a plain view');
create temp table acl_before as select relacl::text as acl from pg_class where oid = 'public.public_artists'::regclass;
revoke insert, update, delete, truncate, references, trigger on public_artists from anon, authenticated;
select tt.check((select relacl::text from pg_class where oid = 'public.public_artists'::regclass) = (select acl from acl_before), 'running the 0045 revoke again changes nothing');

\echo ''
\echo 'ALL PUBLIC ARTISTS READ-ONLY DATABASE TESTS PASSED'
rollback;
