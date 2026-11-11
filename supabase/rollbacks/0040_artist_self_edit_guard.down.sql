-- REVERSE of 0040_artist_self_edit_guard.sql — run by hand only, BEFORE
-- rollbacks/0039_no_zero_price_ticket_types.down.sql.
--
-- Drops the artist self-edit guard. Artists can then again change every
-- column of their own row except status (0003). No data is changed.

begin;

drop trigger if exists artists_guard_self_edit on artists;
drop function if exists guard_artist_self_edit();

commit;
