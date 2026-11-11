-- Tangy Sessions — no booking after a session's date (0038).
--
-- Part 1 checks event_booking_closed() at exact instants (the date boundary in
-- the event's own timezone, never UTC). Part 2 calls create_pending_booking the
-- way razorpay-create-order does (service role) with the real clock.
-- Test-owned rows only; one transaction, rolled back.
-- Run: scripts/test-db.sh / scripts/test-db-local.sh

\set ON_ERROR_STOP 1
\set QUIET 1
begin;

create schema tt;
create function tt.check(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL [%]', p_label; end if;
  raise notice 'ok  %', p_label;
end $$;
create function tt.expect_error(p_sql text, p_pattern text, p_label text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL [%]: expected an error matching "%", but the statement succeeded', p_label, p_pattern;
exception when others then
  if sqlerrm like 'FAIL [%' then raise; end if;
  if sqlerrm not ilike p_pattern then raise exception 'FAIL [%]: expected "%", got "%"', p_label, p_pattern, sqlerrm; end if;
  raise notice 'ok  %', p_label;
end $$;
create function tt.closed(p_date date, p_tz text, p_status text, p_at timestamptz) returns boolean language sql as $$
  select event_booking_closed(p_date, p_tz, p_status, p_at);
$$;
grant usage on schema tt to service_role, authenticated;

\echo '--- 1. the boundary, at exact instants'
-- Asia/Kolkata (UTC+05:30), the default.
select tt.check(not tt.closed('2026-10-04', 'Asia/Kolkata', 'on-sale', '2026-10-03 23:59:59+05:30'), 'Kolkata: the evening before → open');
select tt.check(not tt.closed('2026-10-04', 'Asia/Kolkata', 'on-sale', '2026-10-04 00:00:00+05:30'), 'Kolkata: 00:00 on the day → open');
select tt.check(not tt.closed('2026-10-04', 'Asia/Kolkata', 'on-sale', '2026-10-04 23:59:59+05:30'), 'Kolkata: 23:59:59 on the day → open (same-day bookings)');
select tt.check(tt.closed('2026-10-04', 'Asia/Kolkata', 'on-sale', '2026-10-05 00:00:00+05:30'), 'Kolkata: local midnight after the day → closed');
select tt.check(tt.closed('2026-10-04', 'Asia/Kolkata', 'on-sale', '2026-10-04 23:00:00+00')
  and ('2026-10-04 23:00:00+00'::timestamptz at time zone 'UTC')::date = '2026-10-04',
  'Kolkata: 04:30 IST next morning → closed, although the UTC date is still the event date');
-- A timezone ahead of UTC.
select tt.check(tt.closed('2026-10-04', 'Pacific/Kiritimati', 'on-sale', '2026-10-04 12:00:00+00'),
  'UTC+14: already the next local day while UTC is still on the event date → closed');
-- A timezone behind UTC.
select tt.check(not tt.closed('2026-10-04', 'America/Los_Angeles', 'on-sale', '2026-10-05 05:00:00+00'),
  'UTC−7: still the event''s local evening while UTC is already the next day → open');
select tt.check(tt.closed('2026-10-04', 'America/Los_Angeles', 'on-sale', '2026-10-05 07:00:00+00'), 'UTC−7: after local midnight → closed');
-- Status.
select tt.check(tt.closed('2030-01-01', 'Asia/Kolkata', 'past', now()), 'status past closes even a future-dated session');
select tt.check(tt.closed('2020-01-01', 'Asia/Kolkata', 'on-sale', now()), 'on-sale does not keep a past date open');
select tt.check(tt.closed('2020-01-01', 'Asia/Kolkata', 'sold-out', now()), 'nor does sold-out');
select tt.check(not tt.closed('2030-01-01', 'Asia/Kolkata', 'sold-out', now()), 'a future sold-out session is not "closed" by this rule (capacity decides)');
select tt.check(tt.closed('2026-10-04', null, 'on-sale', '2026-10-05 00:00:00+05:30') and tt.closed('2026-10-04', '', 'on-sale', '2026-10-05 00:00:00+05:30')
  and not tt.closed('2026-10-04', null, 'on-sale', '2026-10-04 23:59:59+05:30'), 'missing timezone falls back to Asia/Kolkata');

\echo '--- 2. create_pending_booking with the real clock'
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000dd001', 'test-a@pastev.tangy.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000dd002', 'test-b@pastev.tangy.test', 'authenticated', 'authenticated');
-- Dates are relative to each event's own local "today".
insert into events (id, slug, name, event_date, timezone, capacity, price, status) values
  ('00000000-0000-0000-0000-0000000dd0e1', 'test-pe-yesterday', 'Yesterday (IST)', (now() at time zone 'Asia/Kolkata')::date - 1, 'Asia/Kolkata', 50, 500, 'on-sale'),
  ('00000000-0000-0000-0000-0000000dd0e2', 'test-pe-today', 'Today (IST)', (now() at time zone 'Asia/Kolkata')::date, 'Asia/Kolkata', 50, 500, 'on-sale'),
  ('00000000-0000-0000-0000-0000000dd0e3', 'test-pe-future', 'Future (IST)', (now() at time zone 'Asia/Kolkata')::date + 10, 'Asia/Kolkata', 50, 500, 'on-sale'),
  ('00000000-0000-0000-0000-0000000dd0e4', 'test-pe-status-past', 'Marked past', (now() at time zone 'Asia/Kolkata')::date + 10, 'Asia/Kolkata', 50, 500, 'past'),
  ('00000000-0000-0000-0000-0000000dd0e5', 'test-pe-la-today', 'Today (Los Angeles)', (now() at time zone 'America/Los_Angeles')::date, 'America/Los_Angeles', 50, 500, 'on-sale'),
  ('00000000-0000-0000-0000-0000000dd0e6', 'test-pe-kir-yesterday', 'Yesterday (Kiritimati)', (now() at time zone 'Pacific/Kiritimati')::date - 1, 'Pacific/Kiritimati', 50, 500, 'on-sale');
create function tt.hold(p_user uuid, p_event uuid, p_code text) returns bookings language sql as $$
  select create_pending_booking(p_user, p_event, p_code, 'Test Buyer', 'buyer@pastev.tangy.test', '9876543210',
         2, null, 'gen', null, array['Guest 1', 'Guest 2'], '{"answers":{}}'::jsonb);
$$;
create function tt.rows(p_event uuid) returns bigint language sql as $$ select count(*) from bookings where event_id = p_event; $$;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

select tt.expect_error($$select tt.hold('00000000-0000-0000-0000-0000000dd001', '00000000-0000-0000-0000-0000000dd0e1', 'TEST-PE-1')$$,
  '%EVENT_CLOSED%', 'a session dated yesterday (still on-sale) cannot be booked');
select tt.check(tt.rows('00000000-0000-0000-0000-0000000dd0e1') = 0, 'no hold was placed for it');
select tt.expect_error($$select tt.hold('00000000-0000-0000-0000-0000000dd001', '00000000-0000-0000-0000-0000000dd0e4', 'TEST-PE-2')$$,
  '%EVENT_CLOSED%', 'a session marked past cannot be booked, whatever its date');
select tt.check((tt.hold('00000000-0000-0000-0000-0000000dd001', '00000000-0000-0000-0000-0000000dd0e2', 'TEST-PE-3')).status = 'pending',
  'a session today can be booked (same-day)');
select tt.check((tt.hold('00000000-0000-0000-0000-0000000dd001', '00000000-0000-0000-0000-0000000dd0e3', 'TEST-PE-4')).status = 'pending',
  'a future session books normally');
select tt.check((tt.hold('00000000-0000-0000-0000-0000000dd001', '00000000-0000-0000-0000-0000000dd0e5', 'TEST-PE-5')).status = 'pending',
  'today in Los Angeles is bookable, whatever the date in UTC or India');
select tt.expect_error($$select tt.hold('00000000-0000-0000-0000-0000000dd001', '00000000-0000-0000-0000-0000000dd0e6', 'TEST-PE-6')$$,
  '%EVENT_CLOSED%', 'yesterday in Kiritimati is closed, whatever the date in UTC or India');

\echo '--- 3. a session that moves into the past'
insert into bookings (registration_code, user_id, event_id, attendee_name, attendee_email, quantity, amount, status, razorpay_order_id)
  select 'TEST-PE-HOLD', '00000000-0000-0000-0000-0000000dd002', '00000000-0000-0000-0000-0000000dd0e3', 'B', 'b@x.test', 1, 590, 'pending', 'order_test_pe_hold';
reset role;
update events set event_date = (now() at time zone 'Asia/Kolkata')::date - 2 where id = '00000000-0000-0000-0000-0000000dd0e3';
set local role service_role;
select tt.expect_error($$select tt.hold('00000000-0000-0000-0000-0000000dd002', '00000000-0000-0000-0000-0000000dd0e3', 'TEST-PE-7')$$,
  '%EVENT_CLOSED%', 'once the date has passed, a new checkout is refused...');
select tt.check((select status::text from bookings where registration_code = 'TEST-PE-HOLD') = 'pending',
  '...before touching the account''s existing hold (not replaced or released)');

\echo '--- 4. the normal checkout is unchanged'
select tt.check((select razorpay_order_id is null from bookings where registration_code = 'TEST-PE-3'), 'today''s hold awaits its order');
update bookings set razorpay_order_id = 'order_test_pe_3' where registration_code = 'TEST-PE-3';
select tt.check((settle_payment('order_test_pe_3', 'pay_test_pe_3', 118000, 'webhook')) ->> 'result' = 'confirmed', 'paying today''s hold confirms it');
select tt.check((select count(*) from tickets t join bookings b on b.id = t.booking_id where b.registration_code = 'TEST-PE-3') = 2, 'tickets issued');

\echo '--- 5. not callable from the browser'
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000dd001","role":"authenticated"}', true);
set local role authenticated;
select tt.expect_error($$select create_pending_booking('00000000-0000-0000-0000-0000000dd001', '00000000-0000-0000-0000-0000000dd0e1', 'TEST-PE-8',
  'x', 'x@x.test', '9876543210', 1, 1, 'gen', null, array['x'], '{"answers":{}}'::jsonb)$$, '%permission denied%',
  'a signed-in user cannot call the booking function directly');
select tt.expect_error($$select event_booking_closed(current_date, 'Asia/Kolkata', 'on-sale')$$, '%permission denied%', 'nor the date helper');
reset role;

\echo ''
\echo 'ALL PAST-EVENT BOOKING DATABASE TESTS PASSED'
rollback;
