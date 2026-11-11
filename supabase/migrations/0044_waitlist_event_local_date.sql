-- Tangy Sessions — the waitlist uses the session's own local date.
--
-- join_waitlist (0027) and offer_waitlist_seats (0029) closed a session's
-- waitlist with `event_date < current_date` — the database clock (UTC), not
-- the session's timezone. Between 00:00 and 05:30 IST a session from the
-- previous evening still counted as open, and a session's own late evening
-- could already count as past in a UTC+ zone. Both now use
-- event_booking_closed(event_date, timezone, status) — the rule bookings use
-- since 0038 (status 'past', or a date before today in the event's own
-- timezone). Bodies are otherwise unchanged; grants are kept by CREATE OR
-- REPLACE.

create or replace function join_waitlist(p_event_id uuid, p_quantity integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me profiles%rowtype;
  v_event events%rowtype;
  v_free int;
  v_id uuid;
  v_pos int;
begin
  select * into v_me from profiles where id = auth.uid() and is_active;
  if v_me.id is null then
    raise exception 'Sign in to join the waitlist.';
  end if;
  select * into v_event from events where id = p_event_id for update;
  if v_event.id is null or v_event.status in ('draft', 'cancelled') or event_booking_closed(v_event.event_date, v_event.timezone, v_event.status) then
    raise exception 'WAITLIST_CLOSED: This session isn''t taking waitlist entries.';
  end if;
  if p_quantity is null or p_quantity < v_event.booking_min_quantity or p_quantity > v_event.booking_max_quantity then
    raise exception 'INVALID_QUANTITY: % to % people per booking', v_event.booking_min_quantity, v_event.booking_max_quantity;
  end if;
  if exists (select 1 from waitlist where event_id = p_event_id and user_id = v_me.id and status in ('waiting', 'offered')) then
    raise exception 'ALREADY_WAITLISTED: You''re already on the waitlist for this session.';
  end if;
  v_free := v_event.capacity
            - coalesce((select sum(quantity) from bookings where event_id = p_event_id and status in ('pending', 'confirmed')), 0)
            - waitlist_held_seats(p_event_id);
  if v_event.status <> 'sold-out' and v_free >= p_quantity
     and not exists (select 1 from waitlist where event_id = p_event_id and status = 'waiting' and user_id is not null) then
    raise exception 'SEATS_AVAILABLE: Seats are available — book them directly.';
  end if;
  insert into waitlist (event_id, user_id, name, email, phone, quantity, status)
  values (p_event_id, v_me.id, coalesce(v_me.full_name, v_me.email), v_me.email, v_me.phone, p_quantity, 'waiting')
  returning id into v_id;
  select count(*) into v_pos from waitlist w, waitlist me
   where me.id = v_id and w.event_id = me.event_id and w.status = 'waiting' and w.user_id is not null and w.queue_no <= me.queue_no;
  perform notify(v_me.id, 'waitlist.joined', 'You''re on the waitlist: ' || v_event.name,
    format('Position %s. If seats open up we''ll hold them for you and let you know.', v_pos), '/sessions/' || v_event.slug, p_event_id);
  return jsonb_build_object('id', v_id, 'position', v_pos, 'status', 'waiting');
end;
$function$

;

create or replace function offer_waitlist_seats(p_event_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_event events%rowtype;
  v_free int;
  v_hold int := setting_number('waitlist.offer_hold_minutes', 120)::int;
  v_first_fit boolean := coalesce((select value #>> '{}' from system_settings where key = 'waitlist.allocation'), 'strict_order') = 'first_fit';
  r record;
  v_offered int := 0;
begin
  select * into v_event from events where id = p_event_id for update;
  if v_event.id is null or v_event.status in ('draft', 'cancelled') or event_booking_closed(v_event.event_date, v_event.timezone, v_event.status) then
    return 0;
  end if;
  -- Lapsed offers first, so their seats flow onwards in this same pass.
  update waitlist set status = 'expired', resolved_at = now(), updated_at = now()
   where event_id = p_event_id and status = 'offered' and offer_expires_at <= now();
  select v_event.capacity
         - coalesce((select sum(quantity) from bookings where event_id = p_event_id and status in ('pending', 'confirmed')), 0)
         - waitlist_held_seats(p_event_id)
    into v_free;
  for r in select * from waitlist
           where event_id = p_event_id and status = 'waiting' and user_id is not null
           order by queue_no for update loop
    exit when v_free <= 0;
    if r.quantity > v_free then
      exit when not v_first_fit;   -- strict_order: never skip the head of the queue
      continue;                    -- first_fit: try the next party
    end if;
    update waitlist set status = 'offered', offered_at = now(), offer_expires_at = now() + make_interval(mins => v_hold), updated_at = now()
     where id = r.id;
    v_free := v_free - r.quantity;
    v_offered := v_offered + 1;
    perform notify(r.user_id, 'waitlist.offer', 'A seat opened up: ' || v_event.name,
      format('We''re holding %s seat%s for you until %s. Book now to keep them.', r.quantity, case when r.quantity = 1 then '' else 's' end,
             to_char(now() at time zone coalesce(v_event.timezone, 'Asia/Kolkata') + make_interval(mins => v_hold), 'HH12:MI AM, DD Mon')),
      '/sessions/' || v_event.slug, p_event_id);
    insert into audit_logs (actor_id, actor_email, actor_role, action, resource_type, resource_id, event_id, metadata)
    values (null, null, 'system', 'waitlist.offered', 'waitlist', r.id::text, p_event_id,
            jsonb_build_object('quantity', r.quantity, 'hold_minutes', v_hold, 'allocation', case when v_first_fit then 'first_fit' else 'strict_order' end));
  end loop;
  return v_offered;
end;
$function$

;

