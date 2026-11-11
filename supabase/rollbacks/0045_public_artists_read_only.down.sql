-- REVERSE of 0045_public_artists_read_only.sql — run by hand only, BEFORE
-- rollbacks/0044_waitlist_event_local_date.down.sql.
--
-- WARNING: this RE-OPENS the hole 0045 closed — anyone with the public API
-- key can again update or delete approved artists through public_artists.
-- Only use it to return exactly to the pre-0045 privileges.
--
-- Restores the write privileges Supabase's default privileges gave anon and
-- authenticated on the view. SELECT, service_role, the owner, the view
-- definition and the artists table are not touched. No data is changed.

begin;

grant insert, update, delete, truncate, references, trigger on public_artists to anon, authenticated;

commit;
