-- Tangy Sessions — storage follows the review lifecycle.
--
-- 1. sponsor-assets: the sponsor_assets ROW of an approved (or archived)
--    asset could not be deleted by the sponsor (0020 "own delete
--    unreviewed"), but the FILE could: "sponsor-assets: delete" allowed any
--    object in the sponsor's own folder. Deleting it left Tangy's approved
--    record pointing at nothing. Now the sponsor may delete a file only
--    while it is not tied to an approved/archived asset (an unreviewed or
--    changes-requested asset, or an upload whose row was never written or
--    was just removed — the portal deletes the row first, then the file).
--    Curators (entities.manage) keep full control. No UPDATE policy exists,
--    so files cannot be overwritten in place (unchanged).
--
-- 2. artist-media applications/<uid>/…: any signed-in account could upload
--    50 MB files there (and delete them) without having an application. Now
--    uploads and deletes need the caller's own artist application to be
--    open for editing (draft or needs_information) — exactly when the
--    application form (ApplyPage) offers the upload. Submitted, approved,
--    rejected or withdrawn applications are frozen. Reading is unchanged
--    (own files; reviewers with applications.view). The 50 MB limit and the
--    artist folder (<artist id>/…) rules are unchanged.
--
-- No data change; bucket settings unchanged.

-- Used inside storage policies; SECURITY DEFINER so the check does not
-- depend on the caller's RLS view of artist_applications.
create or replace function has_open_artist_application()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from artist_applications
                 where user_id = auth.uid() and status in ('draft', 'needs_information'));
$$;
revoke all on function has_open_artist_application() from public, anon;
grant execute on function has_open_artist_application() to authenticated;

drop policy if exists "sponsor-assets: delete" on storage.objects;
create policy "sponsor-assets: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'sponsor-assets' and (
    public.has_permission('entities.manage')
    or ((storage.foldername(name))[1] = auth.uid()::text
        and not exists (select 1 from public.sponsor_assets sa
                        where sa.storage_path = objects.name and sa.status in ('approved', 'archived')))
  ));

drop policy if exists "artist-media: applicant upload" on storage.objects;
create policy "artist-media: applicant upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'artist-media' and (storage.foldername(name))[1] = 'applications'
              and (storage.foldername(name))[2] = auth.uid()::text and public.has_open_artist_application());
drop policy if exists "artist-media: applicant delete" on storage.objects;
create policy "artist-media: applicant delete" on storage.objects for delete to authenticated
  using (bucket_id = 'artist-media' and (storage.foldername(name))[1] = 'applications'
         and (storage.foldername(name))[2] = auth.uid()::text and public.has_open_artist_application());
