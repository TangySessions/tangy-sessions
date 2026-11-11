-- REVERSE of 0041_storage_lifecycle_guards.sql — run by hand only, BEFORE
-- rollbacks/0040_artist_self_edit_guard.down.sql.
--
-- Restores the sponsor-assets delete policy (0020) and the artist-media
-- applicant upload/delete policies (0033) exactly, and drops
-- has_open_artist_application(). No data is changed.

begin;

drop policy if exists "sponsor-assets: delete" on storage.objects;
create policy "sponsor-assets: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'sponsor-assets' and ((storage.foldername(name))[1] = auth.uid()::text or has_permission('entities.manage')));

drop policy if exists "artist-media: applicant upload" on storage.objects;
create policy "artist-media: applicant upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'artist-media' and (storage.foldername(name))[1] = 'applications' and (storage.foldername(name))[2] = auth.uid()::text);
drop policy if exists "artist-media: applicant delete" on storage.objects;
create policy "artist-media: applicant delete" on storage.objects for delete to authenticated
  using (bucket_id = 'artist-media' and (storage.foldername(name))[1] = 'applications' and (storage.foldername(name))[2] = auth.uid()::text);

drop function if exists has_open_artist_application();

commit;
