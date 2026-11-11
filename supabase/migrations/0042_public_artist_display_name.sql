-- Tangy Sessions — the public artist directory shows the public name only.
--
-- public_artists (0033) exposed artists.name next to stage_name. For an
-- applicant, artists.name is the legal full name from the application
-- (submit_artist_application: about.full_name), so anyone could read an
-- artist's legal name through the public API even though every page shows
-- `stage_name || name`.
--
-- The view keeps the same columns (no consumer changes): `name` is now the
-- public display name — the stage name when there is one, otherwise the
-- name the artist is listed under (a roster artist added by Tangy with a
-- single name keeps showing it). The legal name stays on the artists table,
-- readable only by the artist and the team (RLS unchanged).

create or replace view public_artists as
  select id, coalesce(nullif(btrim(stage_name), ''), name) as name, stage_name, genre, subgenre, city, bio, avatar_url,
         instagram, soundcloud, spotify, youtube, performance_type, applied_at, slug,
         cover_url, long_bio, country, languages, instruments, genres, years_active, website, highlights
  from artists
  where status = 'approved'::application_status;
grant select on public_artists to anon, authenticated;
