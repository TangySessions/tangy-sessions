-- Tangy Sessions — multi-step writes made consistent (0043):
-- set_programme_sessions() replaces a programme's sessions atomically, and
-- the two artist approval paths keep the artist and its application in step.
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
create function tt.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function tt.login(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function tt.logout() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tt.links(p uuid) returns text language sql security definer set search_path = public as $$
  select coalesce(string_agg(e.slug, ',' order by pe.position), '') from programme_events pe join events e on e.id = pe.event_id where pe.programme_id = p;
$$;
create function tt.app_status(p uuid) returns text language sql security definer set search_path = public as $$ select status from artist_applications where id = p; $$;
grant usage on schema tt to anon, authenticated;
grant execute on all functions in schema tt to anon, authenticated;

insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000c4301', 'test-admin@multi.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Admin"}'),
  ('00000000-0000-0000-0000-0000000c4302', 'test-staff@multi.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Staff"}'),
  ('00000000-0000-0000-0000-0000000c4303', 'test-artist@multi.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Artist One"}'),
  ('00000000-0000-0000-0000-0000000c4304', 'test-artist2@multi.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Artist Two"}');
update profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000c4301';
update profiles set role = 'staff' where id = '00000000-0000-0000-0000-0000000c4302';
insert into events (id, slug, name, event_date, capacity, price, status) values
  ('00000000-0000-0000-0000-0000000c43e1', 'test-ms-a', 'Session A', current_date - 30, 40, 500, 'past'),
  ('00000000-0000-0000-0000-0000000c43e2', 'test-ms-b', 'Session B', current_date - 20, 40, 500, 'past'),
  ('00000000-0000-0000-0000-0000000c43e3', 'test-ms-c', 'Session C', current_date - 10, 40, 500, 'past');
insert into programmes (id, slug, title, year, status) values ('00000000-0000-0000-0000-0000000c43f1', 'test-ms-season', 'Test Season', 2026, 'draft');

\echo '--- 1. set_programme_sessions: whole list or nothing'
select tt.login('00000000-0000-0000-0000-0000000c4301');
select tt.check(set_programme_sessions('00000000-0000-0000-0000-0000000c43f1', array['00000000-0000-0000-0000-0000000c43e1', '00000000-0000-0000-0000-0000000c43e2']::uuid[]) = 2
  and tt.links('00000000-0000-0000-0000-0000000c43f1') = 'test-ms-a,test-ms-b', 'an editor links sessions A, B (in order)');
select tt.check(set_programme_sessions('00000000-0000-0000-0000-0000000c43f1', array['00000000-0000-0000-0000-0000000c43e3', '00000000-0000-0000-0000-0000000c43e1']::uuid[]) = 2
  and tt.links('00000000-0000-0000-0000-0000000c43f1') = 'test-ms-c,test-ms-a', 'replacing the list reorders it (C, A)');
select tt.check(tt.err($$select set_programme_sessions('00000000-0000-0000-0000-0000000c43f1', array['00000000-0000-0000-0000-0000000c43e2', '00000000-0000-0000-0000-00000000dead']::uuid[])$$) like '23503%'
  and tt.links('00000000-0000-0000-0000-0000000c43f1') = 'test-ms-c,test-ms-a', 'a failing insert (unknown session) → error, the previous list intact (was: emptied)');
select tt.check(tt.err($$select set_programme_sessions('00000000-0000-0000-0000-0000000c43f1', array['00000000-0000-0000-0000-0000000c43e2', '00000000-0000-0000-0000-0000000c43e2']::uuid[])$$) like '%only once%'
  and tt.links('00000000-0000-0000-0000-0000000c43f1') = 'test-ms-c,test-ms-a', 'a duplicate → refused, list intact');
select tt.check(tt.err($$select set_programme_sessions('00000000-0000-0000-0000-00000000beef', array[]::uuid[])$$) like '%Programme not found%', 'unknown programme → refused');
select tt.login('00000000-0000-0000-0000-0000000c4302');
select tt.check(tt.err($$select set_programme_sessions('00000000-0000-0000-0000-0000000c43f1', array[]::uuid[])$$) like '42501%', 'staff without content edit rights → refused');
select tt.login('00000000-0000-0000-0000-0000000c4301');
select tt.check(tt.links('00000000-0000-0000-0000-0000000c43f1') = 'test-ms-c,test-ms-a', '...nothing changed');
select tt.check(set_programme_sessions('00000000-0000-0000-0000-0000000c43f1', array[]::uuid[]) = 0 and tt.links('00000000-0000-0000-0000-0000000c43f1') = '', 'an empty list clears it');
select tt.logout();
select tt.check(not has_function_privilege('anon', 'public.set_programme_sessions(uuid, uuid[])', 'execute'), 'not callable anonymously');
select tt.check((select not prosecdef from pg_proc where proname = 'set_programme_sessions'), 'security invoker — RLS still applies');
delete from programmes where id = '00000000-0000-0000-0000-0000000c43f1';
select tt.check(not exists (select 1 from programme_events where programme_id = '00000000-0000-0000-0000-0000000c43f1'), 'deleting a programme removes its links in the same statement (cascade, unchanged)');

\echo '--- 2. the two artist approval paths stay in step'
insert into artists (id, user_id, name, stage_name, email, status) values
  ('00000000-0000-0000-0000-0000000c43a1', '00000000-0000-0000-0000-0000000c4303', 'Artist One', 'One', 'test-artist@multi.tangy.test', 'pending'),
  ('00000000-0000-0000-0000-0000000c43a2', '00000000-0000-0000-0000-0000000c4304', 'Artist Two', 'Two', 'test-artist2@multi.tangy.test', 'pending');
select set_config('tangy.application_rpc', 'on', true);
insert into artist_applications (id, user_id, artist_id, status, data) values
  ('00000000-0000-0000-0000-0000000c43b1', '00000000-0000-0000-0000-0000000c4303', '00000000-0000-0000-0000-0000000c43a1', 'needs_information', '{"about":{"stage_name":"One"}}'),
  ('00000000-0000-0000-0000-0000000c43b2', '00000000-0000-0000-0000-0000000c4304', '00000000-0000-0000-0000-0000000c43a2', 'under_review', '{"about":{"stage_name":"Two"}}');
select set_config('tangy.application_rpc', 'off', true);
select tt.login('00000000-0000-0000-0000-0000000c4301');
select approve_artist_application('00000000-0000-0000-0000-0000000c43a1', null);
select tt.check(tt.app_status('00000000-0000-0000-0000-0000000c43b1') = 'approved', 'legacy queue approves the artist while the application waits for information → application approved too (was: stuck)');
select review_artist_application('00000000-0000-0000-0000-0000000c43b2', 'reject', null, 'Not this season.', 'Fit');
select tt.check(tt.app_status('00000000-0000-0000-0000-0000000c43b2') = 'rejected'
  and (select status::text = 'rejected' from artists where id = '00000000-0000-0000-0000-0000000c43a2'), 'wizard review rejects → artist and application both rejected');
select tt.login('00000000-0000-0000-0000-0000000c4302');
select tt.check(tt.err($$select approve_artist_application('00000000-0000-0000-0000-0000000c43a2', null)$$) like '%permission%'
  and tt.err($$select review_artist_application('00000000-0000-0000-0000-0000000c43b2', 'approve')$$) like '%permission%', 'both paths require applications.review (staff refused)');
select tt.logout();

\echo ''
\echo 'ALL MULTI-STEP CONSISTENCY DATABASE TESTS PASSED'
rollback;
