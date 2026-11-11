-- Tangy Sessions — two multi-step writes made consistent.
--
-- 1. A programme's sessions were saved as two requests from the console:
--    delete every programme_events row, then insert the new list. If the
--    insert failed (network, a bad event id, a policy refusal) the programme
--    was left with no sessions. set_programme_sessions() replaces the list
--    in one transaction. It is SECURITY INVOKER, so the existing
--    programme_events policies (content_can('edit', 'sessions')) decide who
--    may call it — nothing is widened. (Deleting a programme was already a
--    single statement; programme_events cascade with it.)
--
-- 2. Approving or rejecting the artist row directly (approve_/
--    reject_artist_application, the legacy review queue) synced the decision
--    onto the artist's wizard application only while it was submitted or
--    under review; one waiting in needs_information stayed there although
--    the artist had been decided. The sync now covers that state too, so the
--    two approval paths (review_artist_application calls these same
--    functions) cannot leave the records disagreeing.

create or replace function set_programme_sessions(p_programme_id uuid, p_event_ids uuid[])
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count int;
begin
  if not content_can('edit', 'sessions') then
    raise exception 'You do not have permission to edit programmes.' using errcode = '42501';
  end if;
  if not exists (select 1 from programmes where id = p_programme_id) then
    raise exception 'Programme not found.';
  end if;
  if exists (select 1 from unnest(coalesce(p_event_ids, '{}')) e group by e having count(*) > 1) then
    raise exception 'A session can be listed only once.';
  end if;
  delete from programme_events where programme_id = p_programme_id;
  insert into programme_events (programme_id, event_id, position)
    select p_programme_id, e, (o - 1)::int from unnest(coalesce(p_event_ids, '{}')) with ordinality as u(e, o);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function set_programme_sessions(uuid, uuid[]) from public, anon;
grant execute on function set_programme_sessions(uuid, uuid[]) to authenticated;

create or replace function sync_artist_application_status()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status is distinct from old.status and new.status in ('approved', 'rejected') then
    perform set_config('tangy.application_rpc', 'on', true);
    update artist_applications set status = new.status::text, decided_at = coalesce(decided_at, now())
      where artist_id = new.id and status in ('submitted', 'under_review', 'needs_information');
  end if;
  return new;
end;
$$;
