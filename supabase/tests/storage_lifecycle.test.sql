-- Tangy Sessions — storage follows the review lifecycle (0041).
--
-- Writes and deletes storage.objects as each role with RLS on — the checks
-- Storage runs for uploads and deletes. sponsor-assets paths are
-- <sponsor id>/<file> (src/portal/PartnerExtras.jsx); applicant videos are
-- applications/<user id>/<file> (src/artist/portal/pages/ApplyPage.jsx).
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
-- Ground truth, regardless of RLS.
create function tt.exists_(p_bucket text, p_name text) returns boolean language sql security definer as $$
  select exists (select 1 from storage.objects where bucket_id = p_bucket and name = p_name);
$$;
-- Delete as the current caller; true when a row was actually deleted.
create function tt.del(p_bucket text, p_name text) returns boolean language plpgsql as $$
declare n int;
begin
  delete from storage.objects where bucket_id = p_bucket and name = p_name;
  get diagnostics n = row_count;
  return n = 1;
end $$;
create function tt.put(p_bucket text, p_name text) returns text language plpgsql as $$
begin
  return tt.err(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, auth.uid())', p_bucket, p_name));
end $$;
grant usage on schema tt to anon, authenticated;
grant execute on all functions in schema tt to anon, authenticated;

insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000c1001', 'test-sponsor@life.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Sponsor"}'),
  ('00000000-0000-0000-0000-0000000c1002', 'test-sponsor2@life.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Other Sponsor"}'),
  ('00000000-0000-0000-0000-0000000c1003', 'test-admin@life.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Admin"}'),
  ('00000000-0000-0000-0000-0000000c1004', 'test-applicant@life.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Applicant"}'),
  ('00000000-0000-0000-0000-0000000c1005', 'test-random@life.tangy.test', 'authenticated', 'authenticated', '{"full_name":"No Application"}'),
  ('00000000-0000-0000-0000-0000000c1006', 'test-applicant2@life.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Applicant Two"}');
update profiles set role = 'sponsor' where id in ('00000000-0000-0000-0000-0000000c1001', '00000000-0000-0000-0000-0000000c1002');
update profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000c1003';

\echo '--- 1. sponsor assets: unreviewed files are the sponsor''s, approved files are Tangy''s'
select tt.login('00000000-0000-0000-0000-0000000c1001');
select tt.check(tt.put('sponsor-assets', '00000000-0000-0000-0000-0000000c1001/logo.png') is null, 'sponsor uploads into their own folder');
select tt.check(tt.put('sponsor-assets', '00000000-0000-0000-0000-0000000c1001/guide.pdf') is null, '...a second file');
select tt.check(tt.put('sponsor-assets', '00000000-0000-0000-0000-0000000c1001/orphan.png') is null, '...and one whose row is never written (failed submit)');
select tt.check(tt.put('sponsor-assets', '00000000-0000-0000-0000-0000000c1002/x.png') is not null, 'not into another sponsor''s folder (unchanged)');
insert into sponsor_assets (sponsor_id, title, storage_path) values
  ('00000000-0000-0000-0000-0000000c1001', 'Logo', '00000000-0000-0000-0000-0000000c1001/logo.png'),
  ('00000000-0000-0000-0000-0000000c1001', 'Guidelines', '00000000-0000-0000-0000-0000000c1001/guide.pdf');
select tt.logout();
update sponsor_assets set status = 'approved', reviewed_at = now() where storage_path = '00000000-0000-0000-0000-0000000c1001/logo.png';
select tt.login('00000000-0000-0000-0000-0000000c1001');
select tt.check(not tt.del('sponsor-assets', '00000000-0000-0000-0000-0000000c1001/logo.png') and tt.exists_('sponsor-assets', '00000000-0000-0000-0000-0000000c1001/logo.png'),
  'APPROVED asset: the sponsor cannot delete its file');
with d as (delete from sponsor_assets where storage_path = '00000000-0000-0000-0000-0000000c1001/logo.png' returning 1)
select tt.check(not exists (select 1 from d), '...nor its row (0020, unchanged)');
select tt.check(tt.err($$update storage.objects set name = name where bucket_id = 'sponsor-assets' and name = '00000000-0000-0000-0000-0000000c1001/logo.png'$$) is null
  and tt.exists_('sponsor-assets', '00000000-0000-0000-0000-0000000c1001/logo.png'), '...nor overwrite it (no update policy)');
select tt.check(tt.del('sponsor-assets', '00000000-0000-0000-0000-0000000c1001/orphan.png'), 'a file with no asset row (failed submit) can be cleaned up');
-- The portal's own removal of an unreviewed asset: row first, then file.
with d as (delete from sponsor_assets where storage_path = '00000000-0000-0000-0000-0000000c1001/guide.pdf' returning 1)
select tt.check(exists (select 1 from d), 'unreviewed asset: row deleted');
select tt.check(tt.del('sponsor-assets', '00000000-0000-0000-0000-0000000c1001/guide.pdf'), 'unreviewed asset: file deleted');
select tt.logout();
insert into sponsor_assets (sponsor_id, title, storage_path, status) values ('00000000-0000-0000-0000-0000000c1001', 'Campaign', '00000000-0000-0000-0000-0000000c1001/campaign.png', 'changes_requested');
insert into storage.objects (bucket_id, name) values ('sponsor-assets', '00000000-0000-0000-0000-0000000c1001/campaign.png');
insert into sponsor_assets (sponsor_id, title, storage_path, status) values ('00000000-0000-0000-0000-0000000c1001', 'Old', '00000000-0000-0000-0000-0000000c1001/old.png', 'archived');
insert into storage.objects (bucket_id, name) values ('sponsor-assets', '00000000-0000-0000-0000-0000000c1001/old.png');
select tt.login('00000000-0000-0000-0000-0000000c1001');
select tt.check(tt.del('sponsor-assets', '00000000-0000-0000-0000-0000000c1001/campaign.png'), 'changes-requested asset: the sponsor can still replace/delete the file');
select tt.check(not tt.del('sponsor-assets', '00000000-0000-0000-0000-0000000c1001/old.png'), 'archived asset: protected like approved');
select tt.login('00000000-0000-0000-0000-0000000c1002');
select tt.check(not tt.del('sponsor-assets', '00000000-0000-0000-0000-0000000c1001/logo.png'), 'another sponsor cannot delete it');
select tt.login('00000000-0000-0000-0000-0000000c1003');
select tt.check(tt.del('sponsor-assets', '00000000-0000-0000-0000-0000000c1001/old.png'), 'a curator (entities.manage) can manage approved/archived files');
select tt.logout();

\echo '--- 2. artist-media applications/: only with an application open for editing'
select tt.login('00000000-0000-0000-0000-0000000c1005');
select tt.check(tt.put('artist-media', 'applications/00000000-0000-0000-0000-0000000c1005/big.mp4') like '%row-level security%', 'no application → upload refused');
select tt.logout();
insert into artist_applications (id, user_id, status) values
  ('00000000-0000-0000-0000-0000000c1a04', '00000000-0000-0000-0000-0000000c1004', 'draft'),
  ('00000000-0000-0000-0000-0000000c1a06', '00000000-0000-0000-0000-0000000c1006', 'draft');
select tt.login('00000000-0000-0000-0000-0000000c1004');
select tt.check(tt.put('artist-media', 'applications/00000000-0000-0000-0000-0000000c1004/set.mp4') is null, 'draft application → applicant uploads their video');
select tt.check(tt.put('artist-media', 'applications/00000000-0000-0000-0000-0000000c1006/set.mp4') like '%row-level security%', '...but never into another applicant''s folder');
select tt.check(tt.put('artist-media', 'applications/00000000-0000-0000-0000-0000000c1004/second.mp4') is null, 'replacing the video during the draft works');
select tt.check(tt.del('artist-media', 'applications/00000000-0000-0000-0000-0000000c1004/second.mp4'), '...and the draft''s own files can be deleted');
select tt.check(exists (select 1 from storage.objects where bucket_id = 'artist-media' and name = 'applications/00000000-0000-0000-0000-0000000c1004/set.mp4'), 'the applicant reads their own file (unchanged)');
select tt.login('00000000-0000-0000-0000-0000000c1006');
select tt.check(not tt.del('artist-media', 'applications/00000000-0000-0000-0000-0000000c1004/set.mp4'), 'another applicant cannot delete it');
select tt.check(not exists (select 1 from storage.objects where bucket_id = 'artist-media' and name = 'applications/00000000-0000-0000-0000-0000000c1004/set.mp4'), '...or read it');
select tt.logout();
update artist_applications set status = 'submitted', video_storage_path = 'applications/00000000-0000-0000-0000-0000000c1004/set.mp4' where id = '00000000-0000-0000-0000-0000000c1a04';
select tt.login('00000000-0000-0000-0000-0000000c1004');
select tt.check(tt.put('artist-media', 'applications/00000000-0000-0000-0000-0000000c1004/late.mp4') like '%row-level security%', 'submitted → no more uploads');
select tt.check(not tt.del('artist-media', 'applications/00000000-0000-0000-0000-0000000c1004/set.mp4') and tt.exists_('artist-media', 'applications/00000000-0000-0000-0000-0000000c1004/set.mp4'),
  'submitted → the video under review cannot be deleted');
select tt.logout();
update artist_applications set status = 'needs_information' where id = '00000000-0000-0000-0000-0000000c1a04';
select tt.login('00000000-0000-0000-0000-0000000c1004');
select tt.check(tt.put('artist-media', 'applications/00000000-0000-0000-0000-0000000c1004/better.mp4') is null, 'information requested → uploads open again');
select tt.logout();
update artist_applications set status = 'approved' where id = '00000000-0000-0000-0000-0000000c1a04';
update artist_applications set status = 'rejected' where id = '00000000-0000-0000-0000-0000000c1a06';
select tt.login('00000000-0000-0000-0000-0000000c1004');
select tt.check(tt.put('artist-media', 'applications/00000000-0000-0000-0000-0000000c1004/after.mp4') like '%row-level security%'
  and not tt.del('artist-media', 'applications/00000000-0000-0000-0000-0000000c1004/better.mp4'), 'approved → application files frozen (artists use their own <artist id>/ folder)');
select tt.login('00000000-0000-0000-0000-0000000c1006');
select tt.check(tt.put('artist-media', 'applications/00000000-0000-0000-0000-0000000c1006/again.mp4') like '%row-level security%', 'rejected → no uploads');
select tt.login('00000000-0000-0000-0000-0000000c1003');
select tt.check(tt.del('artist-media', 'applications/00000000-0000-0000-0000-0000000c1004/better.mp4'), 'an admin can still manage application files');
select tt.logout();
select tt.check((select file_size_limit from storage.buckets where id = 'artist-media') = 52428800, 'the 50 MB limit is unchanged');
select tt.check(not has_function_privilege('anon', 'public.has_open_artist_application()', 'execute'), 'the helper is not callable anonymously');

\echo ''
\echo 'ALL STORAGE LIFECYCLE DATABASE TESTS PASSED'
rollback;
