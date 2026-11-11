-- REVERSE of 0042_public_artist_display_name.sql — run by hand only, BEFORE
-- rollbacks/0041_storage_lifecycle_guards.down.sql.
--
-- Restores public_artists exactly as 0033 defined it (exposes artists.name
-- again). No data is changed.

begin;

create or replace view public_artists as
  select id, name, stage_name, genre, subgenre, city, bio, avatar_url, instagram, soundcloud, spotify, youtube,
         performance_type, applied_at, slug,
         cover_url, long_bio, country, languages, instruments, genres, years_active, website, highlights
  from artists
  where status = 'approved'::application_status;
grant select on public_artists to anon, authenticated;

commit;
