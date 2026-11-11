-- Tangy Sessions — ticket types, server-authoritative pricing, payment
-- settlement (0026). One transaction, rolled back at the end.
-- Run: scripts/test-db.sh

\set ON_ERROR_STOP 1
\set QUIET 1
begin;

delete from bookings; delete from waitlist; delete from collaborations; delete from crew_applications;
delete from conversations; delete from notifications; delete from email_outbox;
delete from events; delete from artists; delete from auth.users;

create schema tt;
create function tt.login(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function tt.anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
end $$;
create function tt.logout() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
create function tt.expect_error(p_sql text, p_pattern text, p_label text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL [%]: expected an error matching "%", but the statement succeeded', p_label, p_pattern;
exception when others then
  if sqlerrm like 'FAIL [%' then raise; end if;
  if sqlerrm not ilike p_pattern then
    raise exception 'FAIL [%]: expected error matching "%", got "%"', p_label, p_pattern, sqlerrm;
  end if;
  raise notice 'ok  %', p_label;
end $$;
create function tt.check(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FAIL [%]', p_label;
  end if;
  raise notice 'ok  %', p_label;
end $$;
create function tt.book(p_code text, p_qty int, p_tier text, p_amount int, p_order text, p_event uuid default '00000000-0000-0000-0000-00000000a601')
returns bookings language sql as $$
  select create_pending_booking(null, p_event, p_code, 'Rahul Sharma', 'r@price.tangy.test', '9876543210',
         p_qty, p_amount, p_tier, p_order, (select array_agg('Guest ' || g) from generate_series(1, p_qty) g), '{}'::jsonb);
$$;
create function tt.st(p_code text) returns text language sql security definer as $$
  select status::text || '/' || coalesce(payment_status, '-') from bookings where registration_code = p_code;
$$;
grant usage on schema tt to anon, authenticated;
grant execute on all functions in schema tt to anon, authenticated;

insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000a501', 'admin@price.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Mira Manager"}'),
  ('00000000-0000-0000-0000-00000000a502', 'staff@price.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Sam Staff"}'),
  ('00000000-0000-0000-0000-00000000a503', 'pat@price.tangy.test',   'authenticated', 'authenticated', '{"full_name":"Pat Patron"}');
update profiles set role = 'admin' where id = '00000000-0000-0000-0000-00000000a501';
update profiles set role = 'staff' where id = '00000000-0000-0000-0000-00000000a502';

insert into events (id, slug, name, event_date, venue, capacity, price, status) values
  ('00000000-0000-0000-0000-00000000a601', 'price-a', 'Music Night', current_date + 5, 'Stepwell', 6, 2000, 'on-sale'),
  ('00000000-0000-0000-0000-00000000a602', 'price-d', 'Draft Night', current_date + 9, 'Baradari', 50, 900, 'draft');

\echo '--- 1. Ticket types are data'
select tt.check((select count(*) = 1 and bool_and(code = 'gen' and price = 2000) from event_ticket_types where event_id = '00000000-0000-0000-0000-00000000a601'),
  'a new event starts with General Admission at its listed price');
insert into event_ticket_types (event_id, code, name, price, sort_order, capacity) values
  ('00000000-0000-0000-0000-00000000a601', 'vip', 'VIP', 2500, 2, 2),
  ('00000000-0000-0000-0000-00000000a601', 'old', 'Retired type', 100, 9, null);
update event_ticket_types set active = false where code = 'old';
select tt.check((select price = 2000 from events where id = '00000000-0000-0000-0000-00000000a601'), 'the "from" price is the cheapest active type (inactive ₹100 ignored)');
select tt.anon();
select tt.check((select string_agg(code, ',' order by sort_order) = 'gen,vip' from event_ticket_types), 'public sees active types of published events only (no inactive, no draft)');
select tt.check((select b ->> 'total' = '4720' and b ->> 'subtotal' = '4000' and b ->> 'tax' = '720' from (select booking_quote('00000000-0000-0000-0000-00000000a601', 'gen', 2) b) x),
  'quote: ₹2,000 × 2 = ₹4,000 + 18% GST = ₹4,720');
select tt.expect_error($$select booking_quote('00000000-0000-0000-0000-00000000a601', 'old', 1)$$, '%INVALID_TICKET_TYPE%', 'an inactive type cannot be quoted');
select tt.expect_error($$select booking_quote('00000000-0000-0000-0000-00000000a601', 'gen', 0)$$, '%INVALID_QUANTITY%', 'zero quantity refused');
select tt.expect_error($$select booking_quote('00000000-0000-0000-0000-00000000a601', 'gen', -3)$$, '%INVALID_QUANTITY%', 'negative quantity refused');
select tt.expect_error($$select booking_quote('00000000-0000-0000-0000-00000000a602', 'gen', 1)$$, '%INVALID_TICKET_TYPE%', 'a draft event cannot be quoted');
select tt.check((select (a ->> 'remaining')::int = 6 and jsonb_array_length(a -> 'ticket_types') = 2 and (a -> 'ticket_types' -> 1 ->> 'remaining')::int = 2
  from (select event_availability('00000000-0000-0000-0000-00000000a601') a) x), 'availability: 6 seats, 2 VIP left — counts only');
select tt.logout();

\echo '--- 2. Who can change prices'
select tt.login('00000000-0000-0000-0000-00000000a503');
with u as (update event_ticket_types set price = 1 where code = 'gen' returning id) select tt.check(not exists (select 1 from u), 'a customer cannot change prices');
select tt.expect_error($$insert into event_ticket_types (event_id, code, name, price) values ('00000000-0000-0000-0000-00000000a601', 'cust', 'Customer-made', 100)$$, '%row-level security%', 'a customer cannot add ticket types');
select tt.login('00000000-0000-0000-0000-00000000a502');
with u as (update event_ticket_types set price = 1 where code = 'gen' returning id) select tt.check(not exists (select 1 from u), 'staff cannot change prices');
select tt.login('00000000-0000-0000-0000-00000000a501');
with u as (update event_ticket_types set price = 2200 where code = 'gen' and event_id = '00000000-0000-0000-0000-00000000a601' returning id)
select tt.check(exists (select 1 from u), 'an event manager can change a price');
select tt.logout();
select tt.check((select price = 2200 from events where id = '00000000-0000-0000-0000-00000000a601'), 'the listed "from" price follows');

\echo '--- 3. Checkout charges the server price'
select tt.book('P-GEN', 2, 'gen', 1, 'order_gen');
select tt.check((select amount = 5192 from bookings where registration_code = 'P-GEN'), 'the client''s ₹1 is ignored: 2 × ₹2,200 + 18% = ₹5,192');
select tt.expect_error($$select tt.book('P-OLD', 1, 'old', 1, 'order_old')$$, '%INVALID_TICKET_TYPE%', 'a retired ticket type cannot be booked');
select tt.expect_error($$select tt.book('P-XXX', 1, 'backstage_free', 0, 'order_x')$$, '%INVALID_TICKET_TYPE%', 'an unknown ticket type cannot be booked');
select tt.book('P-VIP', 2, 'vip', 1, 'order_vip');
select tt.expect_error($$select tt.book('P-VIP2', 1, 'vip', 1, 'order_vip2')$$, '%Not enough VIP tickets%', 'a type''s own capacity is enforced');
select tt.expect_error($$select tt.book('P-OVER', 3, 'gen', 1, 'order_over')$$, '%SOLD_OUT%', 'event capacity is enforced (4 of 6 taken)');
select create_pending_booking(null, '00000000-0000-0000-0000-00000000a601', 'P-COMP', 'Guest list', 'gl@x.test', null, 1, 0, 'gen', null);
select tt.check((select amount = 0 from bookings where registration_code = 'P-COMP'), 'service paths without checkout details keep their own amount (complimentary)');

\echo '--- 4. Settlement'
select tt.check((settle_payment('order_gen', 'pay_gen', 519200, 'webhook') ->> 'result') = 'confirmed', 'pending + matching amount -> confirmed');
select tt.check(tt.st('P-GEN') = 'confirmed/captured' and (select count(*) = 2 from tickets t join bookings b on b.id = t.booking_id where b.registration_code = 'P-GEN'), 'tickets issued');
select tt.check((settle_payment('order_gen', 'pay_gen', 519200, 'verify') ->> 'result') = 'already_confirmed', 'a second callback (verify after webhook) is a no-op');
select tt.check((select count(*) = 2 from tickets t join bookings b on b.id = t.booking_id where b.registration_code = 'P-GEN'), 'no duplicate tickets');
select tt.check((settle_payment('order_vip', 'pay_vip', 100, 'webhook') ->> 'result') = 'needs_review', 'a paid amount that doesn''t match the quote is held for review');
select tt.check(tt.st('P-VIP') = 'pending/needs_review', 'and not confirmed');
select tt.check((settle_payment('order_missing', 'pay_x', null, 'webhook') ->> 'result') = 'not_found', 'unknown order -> not_found');
-- Cancelled by an admin, then paid.
select tt.book('P-CXL', 1, 'gen', 1, 'order_cxl');
update bookings set status = 'cancelled' where registration_code = 'P-CXL';
select tt.check((settle_payment('order_cxl', 'pay_cxl', null, 'webhook') ->> 'result') = 'needs_review', 'payment for a cancelled booking is held for review');
select tt.check(tt.st('P-CXL') = 'cancelled/needs_review', 'a cancelled booking is never silently re-confirmed');
-- Expired hold, seats still free -> late payment accepted.
select tt.book('P-LATE', 1, 'gen', 1, 'order_late');
update bookings set status = 'expired' where registration_code = 'P-LATE';
select tt.check((settle_payment('order_late', 'pay_late', null, 'webhook') ->> 'late')::boolean, 'expired, seats still free -> confirmed as a late payment');
select tt.check(tt.st('P-LATE') = 'confirmed/captured' and exists (select 1 from audit_logs where action = 'payment.late_accepted'), 'late acceptance is audited');
-- Expired hold, seats resold -> never over capacity.
update events set capacity = 9 where id = '00000000-0000-0000-0000-00000000a601';
select tt.book('P-GONE', 2, 'gen', 1, 'order_gone');
update bookings set status = 'expired' where registration_code = 'P-GONE';
select tt.book('P-NEW', 3, 'gen', 1, 'order_new');
select tt.check((settle_payment('order_gone', 'pay_gone', null, 'webhook') ->> 'result') = 'needs_review', 'expired and the seats were resold -> held for review');
select tt.check(tt.st('P-GONE') = 'expired/needs_review', 'not confirmed');
select tt.check((select sum(quantity) <= 9 from bookings where event_id = '00000000-0000-0000-0000-00000000a601' and status in ('pending', 'confirmed')), 'held + confirmed seats never exceed capacity');
select tt.check((select count(*) = 3 from notifications where user_id = '00000000-0000-0000-0000-00000000a501' and type = 'payment.review'), 'finance alerted for each review');

\echo '--- 5. Only the server settles'
select tt.login('00000000-0000-0000-0000-00000000a503');
select tt.expect_error($$select settle_payment('order_vip', 'pay_vip', 590000, 'webhook')$$, '%permission denied%', 'a customer cannot settle a payment');
select tt.expect_error($$select create_pending_booking(null, '00000000-0000-0000-0000-00000000a601', 'P-HACK', 'x', 'x@x.test', null, 1, 1, 'gen', null)$$, '%permission denied%', 'a customer cannot create a booking directly');
select tt.login('00000000-0000-0000-0000-00000000a501');
select tt.expect_error($$select settle_payment('order_vip', 'pay_vip', 590000, 'webhook')$$, '%permission denied%', 'even an admin cannot settle a payment by RPC');

\echo ''
\echo 'ALL PRICING AND SETTLEMENT DATABASE TESTS PASSED'
rollback;
