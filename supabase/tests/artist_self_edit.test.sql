-- Tangy Sessions — artists edit their profile, not Tangy's review record (0040).
--
-- Every write below is made the way the API makes it: as the signed-in user
-- (role authenticated + JWT claims), through RLS, exactly what a direct
-- PATCH /rest/v1/artists would do.
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
create function tt.as_user(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function tt.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;
create function tt.as_owner() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
-- The artist row as the table owner sees it (bypasses RLS) — the ground truth.
create function tt.a(p_id uuid) returns artists language sql security definer set search_path = public as $$
  select * from artists where id = p_id;
$$;
create function tt.notes(p_id uuid) returns text language sql security definer set search_path = public as $$
  select notes from application_reviews where source_table = 'artists' and source_id = p_id;
$$;
grant usage on schema tt to anon, authenticated, service_role;
grant execute on all functions in schema tt to anon, authenticated, service_role;

insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000a5e01', 'test-admin@selfedit.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Admin"}'),
  ('00000000-0000-0000-0000-0000000a5e02', 'test-artist@selfedit.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Artist"}'),
  ('00000000-0000-0000-0000-0000000a5e03', 'test-applicant@selfedit.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Applicant"}'),
  ('00000000-0000-0000-0000-0000000a5e04', 'test-other@selfedit.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Other"}'),
  ('00000000-0000-0000-0000-0000000a5e05', 'test-new@selfedit.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test New"}');
update profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000a5e01';
insert into artists (id, user_id, name, stage_name, email, genre, city, status, applied_at) values
  ('00000000-0000-0000-0000-0000000a5ea1', '00000000-0000-0000-0000-0000000a5e02', 'Test Artist', 'Test Stage', 'test-artist@selfedit.tangy.test', 'jazz', 'Pune', 'pending', '2026-09-01 10:00+05:30'),
  ('00000000-0000-0000-0000-0000000a5ea2', '00000000-0000-0000-0000-0000000a5e03', 'Test Applicant', 'Applicant Stage', 'test-applicant@selfedit.tangy.test', 'folk', 'Goa', 'pending', '2026-09-02 10:00+05:30'),
  ('00000000-0000-0000-0000-0000000a5ea3', null, 'Existing Name', 'Taken Slug Artist', 'taken@selfedit.tangy.test', 'rock', 'Delhi', 'approved', '2026-08-01 10:00+05:30');
create temp table baseline as select * from artists where id = '00000000-0000-0000-0000-0000000a5ea1';
grant select on baseline to authenticated, service_role;

\echo '--- 1. a pending applicant cannot forge a review'
select tt.as_user('00000000-0000-0000-0000-0000000a5e02');
select tt.check(tt.err($$update artists set reviewed_by = auth.uid(), reviewed_at = now() where id = '00000000-0000-0000-0000-0000000a5ea1'$$) like '42501%managed by the Tangy team%reviewed_at, reviewed_by%',
  'pending: reviewed_by + reviewed_at refused (42501, readable, names the fields)');
select tt.check(tt.err($$update artists set status = 'approved' where id = '00000000-0000-0000-0000-0000000a5ea1'$$) is not null, 'pending: self-approval refused');
select tt.as_owner();
select tt.check((tt.a('00000000-0000-0000-0000-0000000a5ea1')).status = 'pending' and (tt.a('00000000-0000-0000-0000-0000000a5ea1')).reviewed_by is null, 'still pending, unreviewed');

\echo '--- 2. admin review workflow still works'
select tt.as_user('00000000-0000-0000-0000-0000000a5e01');
select approve_artist_application('00000000-0000-0000-0000-0000000a5ea1', 'Strong live set.');
select reject_artist_application('00000000-0000-0000-0000-0000000a5ea2', 'Not the right fit this season.');
select tt.as_owner();
select tt.check((select status = 'approved' and reviewed_by = '00000000-0000-0000-0000-0000000a5e01' and reviewed_at is not null and slug is not null
  from artists where id = '00000000-0000-0000-0000-0000000a5ea1'), 'approve_artist_application: approved, reviewer and time recorded');
select tt.check(tt.notes('00000000-0000-0000-0000-0000000a5ea1') = 'Strong live set.', 'approval notes stored in application_reviews (0033)');
select tt.check((select status = 'rejected' and reviewed_by = '00000000-0000-0000-0000-0000000a5e01' and decision_reason = 'Not the right fit this season.'
  from artists where id = '00000000-0000-0000-0000-0000000a5ea2'), 'reject_artist_application: rejected with reason');
truncate baseline; insert into baseline select * from artists where id = '00000000-0000-0000-0000-0000000a5ea1';

\echo '--- 3. the approved artist edits their profile (portal Profile page fields)'
select tt.as_user('00000000-0000-0000-0000-0000000a5e02');
update artists set name = 'Test Artist Renamed', stage_name = 'New Stage Name', bio = 'Short bio.', long_bio = 'A much longer bio.',
  genre = 'jazz', subgenre = 'bebop', genres = array['jazz', 'soul'], city = 'Mumbai', country = 'India',
  instagram = 'tester', soundcloud = 'sc', spotify = 'sp', youtube = 'yt', website = 'https://tester.example',
  experience_level = 'professional', performance_type = 'band', years_active = 7, performance_count = 120,
  languages = array['en', 'hi'], instruments = array['sax'], highlights = 'Played everywhere.', notable_venues = array['Blue Frog'],
  audience_metrics = '{"instagram_followers": 1200}', avatar_url = 'https://cdn.example/avatar.jpg', cover_url = 'https://cdn.example/cover.jpg'
where id = '00000000-0000-0000-0000-0000000a5ea1';
select tt.as_owner();
select tt.check((select stage_name = 'New Stage Name' and long_bio = 'A much longer bio.' and genres = array['jazz', 'soul'] and years_active = 7
  and avatar_url = 'https://cdn.example/avatar.jpg' and cover_url = 'https://cdn.example/cover.jpg' and (audience_metrics ->> 'instagram_followers') = '1200'
  from artists where id = '00000000-0000-0000-0000-0000000a5ea1'), 'every profile field (25) saves in one update');
select tt.check((select a.slug = b.slug from artists a, baseline b where a.id = b.id), 'renaming the stage name does not move the public URL');
select tt.as_user('00000000-0000-0000-0000-0000000a5e02');
update artists set avatar_url = 'https://cdn.example/avatar2.jpg' where id = '00000000-0000-0000-0000-0000000a5ea1';
select tt.check((tt.a('00000000-0000-0000-0000-0000000a5ea1')).avatar_url = 'https://cdn.example/avatar2.jpg', 'avatar change (AuthContext.updateUser path) saves');
-- Unchanged protected values in the payload (a form that sends the whole row) are fine.
update artists set bio = 'Bio again.', status = 'approved', email = 'test-artist@selfedit.tangy.test' where id = '00000000-0000-0000-0000-0000000a5ea1';
select tt.check((tt.a('00000000-0000-0000-0000-0000000a5ea1')).bio = 'Bio again.', 'a payload that repeats protected values unchanged still saves');

\echo '--- 4. after approval, every protected field is refused, one at a time'
select tt.check(tt.err($$update artists set status = 'pending' where id = '00000000-0000-0000-0000-0000000a5ea1'$$) is not null, 'status');
select tt.check(tt.err($$update artists set reviewed_by = auth.uid() where id = '00000000-0000-0000-0000-0000000a5ea1'$$) like '42501%reviewed_by%', 'reviewed_by');
select tt.check(tt.err($$update artists set reviewed_by = null where id = '00000000-0000-0000-0000-0000000a5ea1'$$) like '42501%reviewed_by%', 'reviewed_by (clearing it)');
select tt.check(tt.err($$update artists set reviewed_at = now() - interval '1 year' where id = '00000000-0000-0000-0000-0000000a5ea1'$$) like '42501%reviewed_at%', 'reviewed_at');
select tt.check(tt.err($$update artists set applied_at = '2020-01-01' where id = '00000000-0000-0000-0000-0000000a5ea1'$$) like '42501%applied_at%', 'applied_at');
select tt.check(tt.err($$update artists set decision_reason = 'Approved by the founder personally' where id = '00000000-0000-0000-0000-0000000a5ea1'$$) like '42501%decision_reason%', 'decision_reason');
select tt.check(tt.err($$update artists set review_notes = 'Top priority — pay double' where id = '00000000-0000-0000-0000-0000000a5ea1'$$) like '42501%review_notes%', 'review_notes');
select tt.check(tt.err($$update artists set user_id = '00000000-0000-0000-0000-0000000a5e04' where id = '00000000-0000-0000-0000-0000000a5ea1'$$) is not null, 'user_id (hand the profile to another account)');
select tt.check(tt.err($$update artists set user_id = null where id = '00000000-0000-0000-0000-0000000a5ea1'$$) is not null, 'user_id (detach)');
select tt.check(tt.err($$update artists set slug = 'the-real-headliner' where id = '00000000-0000-0000-0000-0000000a5ea1'$$) like '42501%slug%', 'slug');
select tt.check(tt.err($$update artists set slug = null where id = '00000000-0000-0000-0000-0000000a5ea1'$$) like '42501%slug%', 'slug (clearing it to regenerate)');
select tt.check(tt.err($$update artists set email = 'someone-else@example.test' where id = '00000000-0000-0000-0000-0000000a5ea1'$$) like '42501%email%', 'email');
select tt.check(tt.err($$update artists set id = gen_random_uuid() where id = '00000000-0000-0000-0000-0000000a5ea1'$$) is not null, 'id');

\echo '--- 5. mixing a protected field into a legitimate edit refuses the whole update'
select tt.check(tt.err($$update artists set bio = 'Sneaky bio', decision_reason = 'forged' where id = '00000000-0000-0000-0000-0000000a5ea1'$$) like '42501%decision_reason%',
  'bio + decision_reason in one UPDATE refused');
select tt.check(tt.err($$update artists set stage_name = 'X', slug = 'x', reviewed_at = now() - interval '1 day', applied_at = now() where id = '00000000-0000-0000-0000-0000000a5ea1'$$)
  like '42501%applied_at, reviewed_at, slug%', 'several protected fields at once are all named');
-- An upsert (what a PostgREST POST with on_conflict does) is the same UPDATE.
select tt.check(tt.err($$insert into artists (id, user_id, name, email, status) values ('00000000-0000-0000-0000-0000000a5ea1', auth.uid(), 'x', 'x@x.test', 'pending')
  on conflict (id) do update set reviewed_at = now() - interval '2 days', bio = 'upsert'$$) is not null, 'an upsert onto the row is refused too');
select tt.as_owner();
select tt.check((select a.bio = 'Bio again.' and a.stage_name = 'New Stage Name' and a.status = b.status and a.reviewed_by = b.reviewed_by and a.reviewed_at = b.reviewed_at
  and a.applied_at = b.applied_at and a.decision_reason is not distinct from b.decision_reason and a.slug = b.slug and a.user_id = b.user_id and a.email = b.email
  from artists a, baseline b where a.id = b.id), 'after all of that, the review record, identity and the refused edits are unchanged');
select tt.check(tt.notes('00000000-0000-0000-0000-0000000a5ea1') = 'Strong live set.', 'nothing was appended to the internal review notes');
select tt.check((tt.a('00000000-0000-0000-0000-0000000a5ea1')).review_notes is null, 'review_notes column still empty');

\echo '--- 6. other people and a rejected applicant'
select tt.as_user('00000000-0000-0000-0000-0000000a5e03');
select tt.check(tt.err($$update artists set decision_reason = null, status = 'pending' where id = '00000000-0000-0000-0000-0000000a5ea2'$$) is not null, 'a rejected applicant cannot erase the decision');
select tt.check(tt.err($$update artists set decision_reason = null where id = '00000000-0000-0000-0000-0000000a5ea2'$$) like '42501%decision_reason%', '...nor just the reason');
with u as (update artists set bio = 'hijack' where id = '00000000-0000-0000-0000-0000000a5ea1' returning id)
select tt.check(not exists (select 1 from u), 'another user cannot update someone else''s profile at all (RLS unchanged)');
select tt.as_owner();
select tt.check((tt.a('00000000-0000-0000-0000-0000000a5ea2')).decision_reason = 'Not the right fit this season.', 'decision intact');

\echo '--- 7. applying: no backdating, no chosen slug'
select tt.as_user('00000000-0000-0000-0000-0000000a5e05');
insert into artists (id, user_id, name, stage_name, email, status, applied_at, slug, reviewed_by, reviewed_at)
values ('00000000-0000-0000-0000-0000000a5ea5', auth.uid(), 'Test New', 'Fresh Voice', 'test-new@selfedit.tangy.test', 'approved', '2019-01-01', 'the-headliner',
        '00000000-0000-0000-0000-0000000a5e01', '2019-01-02');
select tt.as_owner();
select tt.check((select status = 'pending' and applied_at > now() - interval '1 minute' and slug = 'fresh-voice' and reviewed_by is null and reviewed_at is null
  from artists where id = '00000000-0000-0000-0000-0000000a5ea5'), 'self-apply: status pending, applied_at = now, slug generated from the stage name, review fields cleared');

\echo '--- 8. admins still manage every field, including the public URL'
select tt.as_user('00000000-0000-0000-0000-0000000a5e01');
update artists set slug = 'new-stage-name', email = 'artist-new@selfedit.tangy.test', bio = 'Edited by admin.' where id = '00000000-0000-0000-0000-0000000a5ea1';
select tt.check((select slug = 'new-stage-name' and email = 'artist-new@selfedit.tangy.test' from artists where id = '00000000-0000-0000-0000-0000000a5ea1'),
  'admin sets a custom slug and email (People / Content → Artists editor)');
update artists set slug = null where id = '00000000-0000-0000-0000-0000000a5ea1';
select tt.check((select slug = 'new-stage-name' from artists where id = '00000000-0000-0000-0000-0000000a5ea1'), 'admin clears the slug → regenerated from the current stage name');
select tt.check(tt.err($$update artists set slug = (select slug from artists where id = '00000000-0000-0000-0000-0000000a5ea3') where id = '00000000-0000-0000-0000-0000000a5ea1'$$) like '23505%',
  'a slug already used by another artist is refused (unique)');
select tt.check(tt.err($$update artists set slug = 'Bad Slug!' where id = '00000000-0000-0000-0000-0000000a5ea1'$$) like '%INVALID_SLUG%', 'an invalid slug is refused');
update artists set decision_reason = 'Reviewed again in person.', reviewed_at = now() where id = '00000000-0000-0000-0000-0000000a5ea1';
select tt.check((tt.a('00000000-0000-0000-0000-0000000a5ea1')).decision_reason = 'Reviewed again in person.', 'admin edits review fields directly');
insert into artists (id, name, email, status) values ('00000000-0000-0000-0000-0000000a5ea6', 'Roster Only', 'roster@selfedit.tangy.test', 'approved');
select tt.check((tt.a('00000000-0000-0000-0000-0000000a5ea6')).slug = 'roster-only', 'admin creates a roster artist (approved, slug generated)');
select tt.as_service();
update artists set reviewed_at = reviewed_at where id = '00000000-0000-0000-0000-0000000a5ea1';
update artists set bio = 'Service edit.' where id = '00000000-0000-0000-0000-0000000a5ea1';
select tt.as_owner();
select tt.check((tt.a('00000000-0000-0000-0000-0000000a5ea1')).bio = 'Service edit.', 'the service role (Edge Functions) is not restricted');

\echo '--- 9. the artist''s other workspace tables are unaffected'
select tt.as_user('00000000-0000-0000-0000-0000000a5e02');
insert into artist_private_profiles (artist_id, phone, technical_rider) values ('00000000-0000-0000-0000-0000000a5ea1', '9876543210', 'Two DI boxes.')
  on conflict (artist_id) do update set phone = excluded.phone, technical_rider = excluded.technical_rider;
select tt.check((select technical_rider = 'Two DI boxes.' from artist_private_profiles where artist_id = '00000000-0000-0000-0000-0000000a5ea1'), 'private profile (rider, phone) saves');
insert into artist_media (id, artist_id, storage_path, file_name, media_type, title)
values ('00000000-0000-0000-0000-0000000a5ed1', '00000000-0000-0000-0000-0000000a5ea1', '00000000-0000-0000-0000-0000000a5ea1/demo.mp3', 'demo.mp3', 'demo', 'Demo');
update artist_media set title = 'Demo (live)', status = 'under_review' where id = '00000000-0000-0000-0000-0000000a5ed1';
select tt.check((select title = 'Demo (live)' and status = 'under_review' from artist_media where id = '00000000-0000-0000-0000-0000000a5ed1'), 'media upload record and submit-for-review work as before');
select tt.check(tt.err($$update artist_media set status = 'approved' where id = '00000000-0000-0000-0000-0000000a5ed1'$$) is not null, 'media self-approval still refused (0020 guard unchanged)');
select tt.as_owner();

\echo ''
\echo 'ALL ARTIST SELF-EDIT DATABASE TESTS PASSED'
rollback;
