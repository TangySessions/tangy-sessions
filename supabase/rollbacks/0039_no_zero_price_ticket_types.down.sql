-- REVERSE of 0039_no_zero_price_ticket_types.sql — run by hand only, BEFORE
-- rollbacks/0038_no_booking_after_event_date.down.sql.
--
-- Drops the minimum-price trigger and restores seed_event_ticket_type()
-- exactly as 0026 defined it. No data is changed.

begin;

drop trigger if exists event_ticket_types_price_min on event_ticket_types;
drop function if exists enforce_ticket_type_price();

create or replace function seed_event_ticket_type()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into event_ticket_types (event_id, code, name, price, sort_order)
  values (new.id, 'gen', 'General Admission', coalesce(new.price, 0), 1)
  on conflict (event_id, code) do nothing;
  return new;
end;
$$;

commit;
