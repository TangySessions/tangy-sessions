-- Tangy Sessions — no ₹0 ticket types.
--
-- event_ticket_types.price (whole rupees, 0026) allowed 0, but every booking
-- goes through a Razorpay order (price × people + tax, in paise), and
-- Razorpay cannot take a ₹0 payment — so a ₹0 type is shown on sale and can
-- never be bought. There is no free-booking flow; comps are issued by admins
-- through admin_create_comp_booking, which does not use ticket prices.
--
--  1. A ticket type cannot be created at less than ₹1, and an existing one
--     cannot be changed to less than ₹1 or put back on sale while it is
--     below ₹1. The database is the final check (the admin editor writes
--     with RLS straight to this table); the message is safe to show staff.
--     ₹1 is also Razorpay's minimum (100 paise).
--  2. New events no longer get an automatic "General Admission" type at ₹0
--     when they are created without a price (events.price defaults to 0);
--     with a price of ₹1 or more they get it exactly as before.
--
-- Existing rows are NOT changed. A legacy type already at ₹0 keeps working
-- for everything except being sold: it can be renamed, deactivated, deleted
-- (if unsold) or given a real price. Run
-- preflight/0039_no_zero_price_ticket_types_preflight.sql first to list them;
-- this migration also reports how many there are.
--
-- Positive prices, booking_quote(), create_pending_booking(), RLS and the
-- Razorpay functions are unchanged.

create or replace function enforce_ticket_type_price()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.price < 1 and (tg_op = 'INSERT' or new.price is distinct from old.price or (new.active and not old.active)) then
    raise exception 'A ticket price must be at least ₹1 — online checkout cannot take a ₹0 payment.'
      using errcode = '23514', hint = 'tangy:user';
  end if;
  return new;
end;
$$;
revoke all on function enforce_ticket_type_price() from public, anon, authenticated;

drop trigger if exists event_ticket_types_price_min on event_ticket_types;
create trigger event_ticket_types_price_min before insert or update on event_ticket_types
  for each row execute function enforce_ticket_type_price();

-- 0026's seed, unchanged except that a priceless event gets no ₹0 type.
create or replace function seed_event_ticket_type()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(new.price, 0) < 1 then
    return new;
  end if;
  insert into event_ticket_types (event_id, code, name, price, sort_order)
  values (new.id, 'gen', 'General Admission', new.price, 1)
  on conflict (event_id, code) do nothing;
  return new;
end;
$$;

do $$
declare
  v_active int;
  v_inactive int;
begin
  select count(*) filter (where active), count(*) filter (where not active)
    into v_active, v_inactive from event_ticket_types where price < 1;
  if v_active > 0 then
    raise notice '0039: % ticket type(s) on sale at ₹0 were left unchanged and cannot be bought. Give each a price or take it off sale (see preflight/0039_no_zero_price_ticket_types_preflight.sql).', v_active;
  end if;
  if v_inactive > 0 then
    raise notice '0039: % ticket type(s) at ₹0 are already off sale; left unchanged.', v_inactive;
  end if;
end;
$$;
