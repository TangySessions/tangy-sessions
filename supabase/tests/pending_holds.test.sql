-- Tangy Sessions — one active checkout hold per account per session (0037).
--
-- Calls create_pending_booking the way razorpay-create-order does (service
-- role, customer details path). Test-owned rows only; one transaction,
-- rolled back. Concurrent requests (two real connections) are covered by
-- scripts/test-pending-holds-concurrency.sh.
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
-- A checkout as the Edge Function makes it: no order id yet (attached after
-- Razorpay answers), one name per ticket, details object present.
create function tt.hold(p_user uuid, p_code text, p_qty int, p_phone text default '9876543210') returns bookings language sql as $$
  select create_pending_booking(p_user, '00000000-0000-0000-0000-0000000ab0e1', p_code, 'Test Buyer', 'buyer@holds.tangy.test', p_phone,
         p_qty, null, 'gen', null, (select array_agg('Guest ' || g) from generate_series(1, p_qty) g), '{"answers":{}}'::jsonb);
$$;
-- What the Edge Function does once Razorpay created the order.
create function tt.attach(p_id uuid, p_order text) returns void language sql as $$
  update bookings set razorpay_order_id = p_order where id = p_id;
$$;
create function tt.active(p_user uuid) returns bigint language sql as $$
  select count(*) from bookings where user_id = p_user and event_id = '00000000-0000-0000-0000-0000000ab0e1' and status = 'pending';
$$;
create function tt.held() returns bigint language sql as $$
  select coalesce(sum(quantity), 0) from bookings where event_id = '00000000-0000-0000-0000-0000000ab0e1' and status in ('pending', 'confirmed');
$$;

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000ab001', 'test-a@holds.tangy.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000ab002', 'test-b@holds.tangy.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000ab003', 'test-c@holds.tangy.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000ab004', 'test-d@holds.tangy.test', 'authenticated', 'authenticated');
insert into events (id, slug, name, event_date, capacity, price, status, booking_min_quantity, booking_max_quantity) values
  ('00000000-0000-0000-0000-0000000ab0e1', 'test-holds', 'Test Holds Night', current_date + 20, 6, 500, 'on-sale', 1, 4);
-- Creating the event creates its 'gen' ticket type (0026); make sure it is on sale at 500.
insert into event_ticket_types (event_id, code, name, price, active) values ('00000000-0000-0000-0000-0000000ab0e1', 'gen', 'General', 500, true)
  on conflict (event_id, code) do update set price = 500, active = true, capacity = null;

grant usage on schema tt to service_role;
create temp table ids (k text primary key, id uuid);
grant all on ids to service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

\echo '--- 1. first hold'
insert into ids select 'a1', (tt.hold('00000000-0000-0000-0000-0000000ab001', 'TEST-H-A1', 2)).id;
select tt.attach((select id from ids where k = 'a1'), 'order_test_a1');
select tt.check(tt.active('00000000-0000-0000-0000-0000000ab001') = 1 and tt.held() = 2, 'first hold succeeds (2 seats held)');

\echo '--- 2. a second hold from the same account never coexists with the first'
select tt.check((tt.hold('00000000-0000-0000-0000-0000000ab001', 'TEST-H-A1R', 2)).id = (select id from ids where k = 'a1'),
  'same checkout again (refresh / retry, same details) → the existing hold is returned');
select tt.check((select count(*) from bookings where user_id = '00000000-0000-0000-0000-0000000ab001') = 1 and tt.held() = 2,
  'no second booking row, no extra seats held');
select tt.check((tt.hold('00000000-0000-0000-0000-0000000ab001', 'TEST-H-A1R', 2)).razorpay_order_id = 'order_test_a1',
  'the returned hold carries its Razorpay order (the Edge Function reuses it)');
insert into ids select 'a2', (tt.hold('00000000-0000-0000-0000-0000000ab001', 'TEST-H-A2', 3)).id;
select tt.check((select status::text from bookings where id = (select id from ids where k = 'a1')) = 'expired'
  and (select expired_at is not null from bookings where id = (select id from ids where k = 'a1')),
  'changed details → the earlier unpaid hold is released (expired)');
select tt.check(tt.active('00000000-0000-0000-0000-0000000ab001') = 1 and tt.held() = 3, 'exactly one active hold remains (3 seats, not 2 + 3)');
select tt.check(exists (select 1 from audit_logs where action = 'booking.superseded' and resource_id = (select id::text from ids where k = 'a1')),
  'the release is audited');
select tt.expect_error($$insert into bookings (registration_code, user_id, event_id, attendee_name, attendee_email, quantity, amount, status)
  values ('TEST-H-RAW', '00000000-0000-0000-0000-0000000ab001', '00000000-0000-0000-0000-0000000ab0e1', 'x', 'x@x.test', 1, 1, 'pending')$$,
  '%bookings_one_active_hold%', 'the database itself refuses a second active hold (unique index), whatever the code path');

\echo '--- 3. different accounts hold legitimately'
insert into ids select 'b1', (tt.hold('00000000-0000-0000-0000-0000000ab002', 'TEST-H-B1', 2)).id;
select tt.check(tt.active('00000000-0000-0000-0000-0000000ab002') = 1 and tt.held() = 5, 'a different account holds its own seats (3 + 2 of 6)');
select tt.expect_error($$select tt.hold('00000000-0000-0000-0000-0000000ab003', 'TEST-H-C1', 2)$$, '%SOLD_OUT%', 'capacity still enforced across accounts (5 + 2 > 6)');
select tt.expect_error($$select tt.hold('00000000-0000-0000-0000-0000000ab002', 'TEST-H-B2', 4)$$, '%SOLD_OUT%',
  'a replacement that does not fit is refused...');
select tt.check((select status::text from bookings where id = (select id from ids where k = 'b1')) = 'pending' and tt.held() = 5,
  '...and the earlier hold is kept (the release rolls back with the refusal)');
select tt.check((select count(*) from bookings where user_id = '00000000-0000-0000-0000-0000000ab002') = 1, 'no stray row from the refused attempt');

\echo '--- 4. a payment in flight is never replaced'
update bookings set payment_status = 'authorized' where id = (select id from ids where k = 'b1');
select tt.expect_error($$select tt.hold('00000000-0000-0000-0000-0000000ab002', 'TEST-H-B3', 1)$$, '%HOLD_IN_PROGRESS%',
  'payment authorized → a new checkout for the session is refused');
update bookings set payment_status = 'needs_review', razorpay_payment_id = 'pay_test_b1' where id = (select id from ids where k = 'b1');
select tt.expect_error($$select tt.hold('00000000-0000-0000-0000-0000000ab002', 'TEST-H-B3', 1)$$, '%HOLD_IN_PROGRESS%',
  'payment held for review → refused');
select tt.check((select status::text from bookings where id = (select id from ids where k = 'b1')) = 'pending', 'the paid hold is untouched');

\echo '--- 5. expired holds never block'
update bookings set created_at = now() - interval '45 minutes' where id = (select id from ids where k = 'a2');
insert into ids select 'a3', (tt.hold('00000000-0000-0000-0000-0000000ab001', 'TEST-H-A3', 1)).id;
select tt.check((select status::text from bookings where id = (select id from ids where k = 'a2')) = 'expired'
  and tt.active('00000000-0000-0000-0000-0000000ab001') = 1, 'a stale hold is swept first; the account gets a new hold');
select tt.check(not exists (select 1 from audit_logs where action = 'booking.superseded' and resource_id = (select id::text from ids where k = 'a2')),
  'the stale hold expired normally (not "superseded")');

\echo '--- 6. failed / cancelled / expired bookings release capacity'
select tt.check(tt.held() = 3, 'held: A 1 + B 2 (expired holds not counted)');
update bookings set status = 'failed', payment_status = 'failed', razorpay_payment_id = null where id = (select id from ids where k = 'b1');
select tt.check(tt.held() = 1, 'a failed booking releases its seats');
insert into ids select 'c1', (tt.hold('00000000-0000-0000-0000-0000000ab003', 'TEST-H-C1', 4)).id;
select tt.check(tt.held() = 5, 'released seats can be taken by another account');
update bookings set status = 'cancelled' where id = (select id from ids where k = 'c1');
select tt.check(tt.held() = 1, 'a cancelled booking releases its seats');
insert into ids select 'b4', (tt.hold('00000000-0000-0000-0000-0000000ab002', 'TEST-H-B4', 2)).id;
select tt.check(tt.active('00000000-0000-0000-0000-0000000ab002') = 1, 'after a failed payment the account can start a new checkout');

\echo '--- 7. paying still works (normal, resumed and late)'
select tt.attach((select id from ids where k = 'a3'), 'order_test_a3');
select tt.check((tt.hold('00000000-0000-0000-0000-0000000ab001', 'TEST-H-A3R', 1)).id = (select id from ids where k = 'a3'), 'retry resumes the hold...');
select tt.check((settle_payment('order_test_a3', 'pay_test_a3', 59000, 'webhook')) ->> 'result' = 'confirmed', '...and its payment confirms it');
select tt.check((select count(*) from tickets where booking_id = (select id from ids where k = 'a3')) = 1, 'tickets issued once');
select tt.check((settle_payment('order_test_a3', 'pay_test_a3', 59000, 'verify')) ->> 'result' = 'already_confirmed', 'settlement stays idempotent');
insert into ids select 'a4', (tt.hold('00000000-0000-0000-0000-0000000ab001', 'TEST-H-A4', 1)).id;
select tt.check(tt.active('00000000-0000-0000-0000-0000000ab001') = 1, 'a confirmed booking does not block buying more later');
select tt.attach((select id from ids where k = 'a4'), 'order_test_a4');
insert into ids select 'a5', (tt.hold('00000000-0000-0000-0000-0000000ab001', 'TEST-H-A5', 2)).id;
select tt.check((settle_payment('order_test_a4', 'pay_test_a4', 59000, 'webhook')) ->> 'result' = 'confirmed',
  'a released (superseded) hold paid later is still honoured while seats are free (late payment)');

\echo '--- 8. throttle on new holds'
reset role;
update events set capacity = 40 where id = '00000000-0000-0000-0000-0000000ab0e1';  -- room for the throttle checks
set local role service_role;
select tt.hold('00000000-0000-0000-0000-0000000ab004', 'TEST-H-D' || g, 1, '98765432' || lpad(g::text, 2, '0')) from generate_series(1, 6) g;
select tt.check((select count(*) from bookings where user_id = '00000000-0000-0000-0000-0000000ab004') = 6
  and tt.active('00000000-0000-0000-0000-0000000ab004') = 1, '6 new checkouts in a row: allowed, still one active hold');
select tt.expect_error($$select tt.hold('00000000-0000-0000-0000-0000000ab004', 'TEST-H-D7', 1, '9876543299')$$, '%RATE_LIMITED%',
  'the 7th new checkout within 10 minutes is refused');
select tt.attach((select id from bookings where user_id = '00000000-0000-0000-0000-0000000ab004' and status = 'pending'), 'order_test_d6');
select tt.check((tt.hold('00000000-0000-0000-0000-0000000ab004', 'TEST-H-D6R', 1, '9876543206')).registration_code = 'TEST-H-D6',
  'resuming the current hold still works while throttled (it is not a new hold)');

\echo '--- 9. privileges unchanged'
reset role;
select tt.check(not has_function_privilege('anon', 'create_pending_booking(uuid,uuid,text,text,text,text,integer,integer,text,text,text[],jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'create_pending_booking(uuid,uuid,text,text,text,text,integer,integer,text,text,text[],jsonb)', 'execute'),
  'create_pending_booking stays service-role only');
select tt.check((select count(*) from system_settings where key in ('bookings.hold_rate_limit', 'bookings.hold_rate_window_minutes') and not exposed) = 2,
  'the two limits are settings, not exposed to visitors');

\echo ''
\echo 'ALL PENDING HOLD DATABASE TESTS PASSED'
rollback;
