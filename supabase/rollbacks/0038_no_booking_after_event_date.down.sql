-- REVERSE of 0038_no_booking_after_event_date.sql — run by hand only, BEFORE
-- rollbacks/0037_one_pending_hold_per_account.down.sql.
--
-- Restores create_pending_booking exactly as 0037 defined it and drops
-- event_booking_closed(). No data is changed.

begin;

create or replace function create_pending_booking(p_user_id uuid, p_event_id uuid, p_registration_code text, p_attendee_name text,
  p_attendee_email text, p_attendee_phone text, p_quantity integer, p_amount integer, p_tier text, p_razorpay_order_id text,
  p_attendee_names text[] default null, p_details jsonb default null)
returns bookings
language plpgsql security definer set search_path = public
as $$
declare
  v_event events%rowtype;
  v_taken int;
  v_held int;
  v_offer waitlist%rowtype;
  v_type event_ticket_types%rowtype;
  v_type_taken int;
  v_booking bookings%rowtype;
  v_names text[];
  v_err text;
  v_details jsonb := coalesce(p_details, '{}'::jsonb);
  v_instagram text;
  v_note text;
  v_collab text[];
  v_collab_note text;
  v_amount int := p_amount;
  v_existing bookings%rowtype;
begin
  if p_attendee_names is not null then
    if not valid_attendee_names(p_attendee_names, p_quantity) then
      raise exception 'INVALID_ATTENDEE_NAMES';
    end if;
    select array_agg(btrim(n) order by i) into v_names from unnest(p_attendee_names) with ordinality u(n, i);
  end if;
  -- One checkout at a time per account (0037): serialize this account's
  -- requests (always taken before the event lock below — fixed order, no
  -- deadlock), so two concurrent calls can never both place a hold.
  if p_user_id is not null then
    perform pg_advisory_xact_lock(hashtext('tangy.booking_hold'), hashtext(p_user_id::text));
  end if;
  perform expire_stale_bookings();
  select * into v_event from events where id = p_event_id for update;
  if v_event.id is null then
    raise exception 'EVENT_NOT_FOUND';
  end if;
  if p_user_id is not null then
    -- A hold whose payment is already in flight or held for review is never
    -- replaced: money may be attached to it.
    if exists (select 1 from bookings where user_id = p_user_id and event_id = p_event_id and status = 'pending'
               and (razorpay_payment_id is not null or payment_status not in ('created', 'failed'))) then
      raise exception 'HOLD_IN_PROGRESS: A payment for this session is already being processed. Check your bookings in a minute before trying again.';
    end if;
    -- This account's current unpaid hold for the session, if any (at most one:
    -- bookings_one_active_hold). It is resumed or replaced below.
    select * into v_existing from bookings
     where user_id = p_user_id and event_id = p_event_id and status = 'pending'
     order by created_at desc limit 1 for update;
  end if;
  if p_details is not null then
    if p_quantity < v_event.booking_min_quantity or p_quantity > v_event.booking_max_quantity then
      raise exception 'INVALID_QUANTITY: % to % tickets per booking', v_event.booking_min_quantity, v_event.booking_max_quantity;
    end if;
    select * into v_type from event_ticket_types where event_id = p_event_id and code = p_tier and active;
    if v_type.id is null then
      raise exception 'INVALID_TICKET_TYPE: This ticket type is not available.';
    end if;
    if v_type.capacity is not null then
      select coalesce(sum(quantity), 0) into v_type_taken from bookings
       where event_id = p_event_id and tier = v_type.code and status in ('pending', 'confirmed')
         and id is distinct from v_existing.id;
      if v_type_taken + p_quantity > v_type.capacity then
        raise exception 'SOLD_OUT: Not enough % tickets left.', v_type.name;
      end if;
    end if;
    v_amount := ((booking_quote(p_event_id, p_tier, p_quantity)) ->> 'total')::int;
    if jsonb_typeof(v_details) <> 'object' then
      raise exception 'INVALID_DETAILS: Booking details are malformed.';
    end if;
    v_err := booking_answers_error(v_event.booking_questions, v_details -> 'answers', p_quantity);
    if v_err is not null then
      raise exception 'INVALID_DETAILS: %', v_err;
    end if;
    v_instagram := nullif(ltrim(btrim(coalesce(v_details ->> 'instagram', '')), '@'), '');
    if v_instagram is not null and v_instagram !~ '^[A-Za-z0-9._]{1,30}$' then
      raise exception 'INVALID_DETAILS: Check your Instagram handle.';
    end if;
    v_note := nullif(btrim(coalesce(v_details ->> 'note', '')), '');
    v_collab_note := nullif(btrim(coalesce(v_details ->> 'collab_note', '')), '');
    if length(v_note) > 1000 or length(v_collab_note) > 1000 then
      raise exception 'INVALID_DETAILS: Messages can be up to 1000 characters.';
    end if;
    if v_details ? 'collab_interests' then
      if jsonb_typeof(v_details -> 'collab_interests') <> 'array' then
        raise exception 'INVALID_DETAILS: Collaboration interests are malformed.';
      end if;
      select nullif(array_agg(distinct x), '{}') into v_collab from jsonb_array_elements_text(v_details -> 'collab_interests') x;
      if v_collab is not null and not v_collab <@ array['artist', 'sponsor', 'volunteer', 'event_team', 'sound_technical', 'video_photo', 'editing', 'graphic_design', 'other']::text[] then
        raise exception 'INVALID_DETAILS: Unknown collaboration interest.';
      end if;
    end if;
  end if;
  if v_existing.id is not null then
    -- Same checkout again (refresh / retry): hand back the existing hold and
    -- its Razorpay order instead of placing a second one.
    if v_existing.razorpay_order_id is not null
       and v_existing.quantity = p_quantity and v_existing.amount = v_amount
       and v_existing.tier is not distinct from p_tier
       and v_existing.attendee_name is not distinct from p_attendee_name
       and v_existing.attendee_email is not distinct from p_attendee_email
       and v_existing.attendee_phone is not distinct from p_attendee_phone
       and v_existing.attendee_names is not distinct from v_names
       and v_existing.booking_answers is not distinct from coalesce(v_details -> 'answers', '{}'::jsonb)
       and v_existing.contact_instagram is not distinct from v_instagram
       and v_existing.customer_note is not distinct from v_note
       and v_existing.collab_interests is not distinct from v_collab
       and v_existing.collab_note is not distinct from v_collab_note then
      return v_existing;
    end if;
  end if;
  -- Throttle new holds per account (each one also creates a Razorpay order).
  if p_user_id is not null and (select count(*) from bookings where user_id = p_user_id
        and created_at > now() - make_interval(mins => setting_number('bookings.hold_rate_window_minutes', 10)::int))
      >= setting_number('bookings.hold_rate_limit', 6) then
    raise exception 'RATE_LIMITED: Too many checkout attempts. Please wait a few minutes and try again.';
  end if;
  if v_existing.id is not null then
    -- Changed details: the earlier unpaid hold is released in this same
    -- transaction, so the account never holds two checkouts for one session.
    update bookings set status = 'expired', expired_at = now() where id = v_existing.id;
    insert into audit_logs (actor_id, actor_email, actor_role, action, resource_type, resource_id, event_id, metadata)
    values (null, null, 'system', 'booking.superseded', 'booking', v_existing.id::text, p_event_id,
            jsonb_build_object('registration_code', v_existing.registration_code, 'reason', 'replaced by a new checkout from the same account'));
  end if;
  -- A live waitlist offer lets its holder use the seats held for them.
  if p_user_id is not null then
    select * into v_offer from waitlist
     where event_id = p_event_id and user_id = p_user_id and status = 'offered' and offer_expires_at > now() for update;
  end if;
  if v_offer.id is not null and p_quantity > v_offer.quantity
     and v_event.capacity - coalesce((select sum(quantity) from bookings where event_id = p_event_id and status in ('pending', 'confirmed')), 0)
         - waitlist_held_seats(p_event_id) < p_quantity - v_offer.quantity then
    raise exception 'SOLD_OUT: Your waitlist offer holds % seat%.', v_offer.quantity, case when v_offer.quantity = 1 then '' else 's' end;
  end if;
  select coalesce(sum(quantity), 0) into v_taken
  from bookings
  where event_id = p_event_id and status in ('pending', 'confirmed');
  v_held := waitlist_held_seats(p_event_id, p_user_id);
  if v_taken + v_held + p_quantity > v_event.capacity then
    raise exception 'SOLD_OUT';
  end if;
  insert into bookings (
    registration_code, user_id, event_id, attendee_name, attendee_email,
    attendee_phone, quantity, amount, tier, status, razorpay_order_id, attendee_names,
    booking_answers, contact_instagram, customer_note, collab_interests, collab_note, waitlist_entry_id
  ) values (
    p_registration_code, p_user_id, p_event_id, p_attendee_name, p_attendee_email,
    p_attendee_phone, p_quantity, v_amount, p_tier, 'pending', p_razorpay_order_id, v_names,
    coalesce(v_details -> 'answers', '{}'::jsonb), v_instagram, v_note, v_collab, v_collab_note, v_offer.id
  )
  returning * into v_booking;
  if v_offer.id is not null then
    -- The pending booking now holds these seats (with its own checkout timer).
    update waitlist set status = 'converted', booking_id = v_booking.id, resolved_at = now(), updated_at = now() where id = v_offer.id;
    insert into audit_logs (actor_id, actor_email, actor_role, action, resource_type, resource_id, event_id, metadata)
    values (p_user_id, p_attendee_email, 'user', 'waitlist.converted', 'waitlist', v_offer.id::text, p_event_id,
            jsonb_build_object('booking_id', v_booking.id, 'registration_code', v_booking.registration_code));
  end if;
  return v_booking;
end;
$$;
revoke execute on function create_pending_booking(uuid, uuid, text, text, text, text, int, int, text, text, text[], jsonb) from public, anon, authenticated;
grant execute on function create_pending_booking(uuid, uuid, text, text, text, text, int, int, text, text, text[], jsonb) to service_role;

drop function if exists event_booking_closed(date, text, text, timestamptz);

commit;
