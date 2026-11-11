-- REVERSE of 0043_atomic_programme_sessions.sql — run by hand only, BEFORE
-- rollbacks/0042_public_artist_display_name.down.sql. Revert the console
-- first (ContentCollections.jsx calls set_programme_sessions since 0043).
--
-- Drops set_programme_sessions() and restores sync_artist_application_status
-- exactly as 0033 defined it. No data is changed.

begin;

drop function if exists set_programme_sessions(uuid, uuid[]);

create or replace function sync_artist_application_status()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status is distinct from old.status and new.status in ('approved', 'rejected') then
    perform set_config('tangy.application_rpc', 'on', true);
    update artist_applications set status = new.status::text, decided_at = coalesce(decided_at, now())
      where artist_id = new.id and status in ('submitted', 'under_review');
  end if;
  return new;
end;
$$;

commit;
