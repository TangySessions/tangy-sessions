-- Tangy Sessions — the public artist directory shows the public name (0042).
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
create function tt.login(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function tt.anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
end $$;
create function tt.logout() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
grant usage on schema tt to anon, authenticated;
grant execute on all functions in schema tt to anon, authenticated;

insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000aa701', 'test-artist@privacy.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Priya Legal Ramanathan"}'),
  ('00000000-0000-0000-0000-0000000aa702', 'test-admin@privacy.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Admin"}'),
  ('00000000-0000-0000-0000-0000000aa703', 'test-pat@privacy.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Patron"}');
update profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000aa702';
insert into artists (id, user_id, name, stage_name, email, genre, status) values
  ('00000000-0000-0000-0000-0000000aa7a1', '00000000-0000-0000-0000-0000000aa701', 'Priya Legal Ramanathan', 'DJ Monsoon', 'test-artist@privacy.tangy.test', 'house', 'approved'),
  ('00000000-0000-0000-0000-0000000aa7a2', null, 'The Roster Band', null, 'roster@privacy.tangy.test', 'rock', 'approved'),
  ('00000000-0000-0000-0000-0000000aa7a3', null, 'Blank Stage Legal', '  ', 'blank@privacy.tangy.test', 'jazz', 'approved'),
  ('00000000-0000-0000-0000-0000000aa7a4', null, 'Pending Legal Name', 'Pending Act', 'pending@privacy.tangy.test', 'folk', 'pending');

\echo '--- 1. anonymous visitors'
select tt.anon();
select tt.check((select name = 'DJ Monsoon' and stage_name = 'DJ Monsoon' from public_artists where id = '00000000-0000-0000-0000-0000000aa7a1'), 'an artist with a stage name: public name = stage name');
select tt.check(not exists (select 1 from public_artists p where p::text ilike '%Priya Legal%'), 'the legal name appears nowhere in the public view');
select tt.check((select name = 'The Roster Band' from public_artists where id = '00000000-0000-0000-0000-0000000aa7a2'), 'a roster artist with only a name keeps it');
select tt.check((select name = 'Blank Stage Legal' from public_artists where id = '00000000-0000-0000-0000-0000000aa7a3'), 'a blank stage name falls back to the listed name');
select tt.check(not exists (select 1 from public_artists where id = '00000000-0000-0000-0000-0000000aa7a4'), 'pending artists are not listed (unchanged)');
select tt.check(not exists (select 1 from information_schema.columns where table_name = 'public_artists' and column_name in ('email', 'user_id', 'reviewed_by', 'decision_reason')), 'no email / account / review columns (unchanged)');
select tt.check(not exists (select 1 from artists where id = '00000000-0000-0000-0000-0000000aa7a1'), 'the artists table itself is not readable anonymously (unchanged)');

\echo '--- 2. the team and the artist still see the legal name where they should'
select tt.login('00000000-0000-0000-0000-0000000aa702');
select tt.check((select name = 'Priya Legal Ramanathan' from artists where id = '00000000-0000-0000-0000-0000000aa7a1'), 'admin reads the legal name from artists');
select tt.login('00000000-0000-0000-0000-0000000aa701');
select tt.check((select name = 'Priya Legal Ramanathan' and email = 'test-artist@privacy.tangy.test' from artists where id = '00000000-0000-0000-0000-0000000aa7a1'), 'the artist reads their own legal name and email');
select tt.login('00000000-0000-0000-0000-0000000aa703');
select tt.check(not exists (select 1 from artists where id = '00000000-0000-0000-0000-0000000aa7a1'), 'another signed-in user cannot read the artists row');
select tt.check((select name from public_artists where id = '00000000-0000-0000-0000-0000000aa7a1') = 'DJ Monsoon', '...and sees only the public name');
select tt.logout();

\echo ''
\echo 'ALL PUBLIC ARTIST PRIVACY DATABASE TESTS PASSED'
rollback;
