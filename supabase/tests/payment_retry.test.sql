-- Tangy Sessions — a failed payment attempt keeps the checkout hold.
--
-- razorpay-webhook now records payment.failed as payment_status = 'failed'
-- on the still-pending hold instead of releasing it (Razorpay lets the
-- customer retry on the same order). This suite checks, on the real schema,
-- that such a hold keeps its seats, settles normally when the retry is paid,
-- resumes on "Try again", and still expires on the normal timeout.
-- scripts/test-webhook-payments.mjs exercises the webhook itself.
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
create function tt.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function tt.hold(p_user uuid, p_code text, p_qty int) returns bookings language sql as $$
  select create_pending_booking(p_user, '00000000-0000-0000-0000-0000000e7ee1', p_code, 'Test Buyer', 'buyer@retry.tangy.test', '9876543210',
         p_qty, null, 'gen', null, (select array_agg('Guest ' || g) from generate_series(1, p_qty) g), '{"answers":{}}'::jsonb);
$$;
create function tt.b(p_code text) returns bookings language sql as $$ select * from bookings where registration_code = p_code; $$;
grant usage on schema tt to service_role;
grant execute on all functions in schema tt to service_role;

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000e7e01', 'test-a@retry.tangy.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000e7e02', 'test-b@retry.tangy.test', 'authenticated', 'authenticated');
insert into events (id, slug, name, event_date, capacity, price, status, booking_min_quantity, booking_max_quantity) values
  ('00000000-0000-0000-0000-0000000e7ee1', 'test-retry', 'Retry Night', current_date + 12, 2, 500, 'on-sale', 1, 4);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

\echo '--- 1. the failed attempt is recorded; the hold keeps its seats'
select tt.check((tt.hold('00000000-0000-0000-0000-0000000e7e01', 'TEST-RT-A', 2)).status = 'pending', 'buyer A holds the last 2 seats');
update bookings set razorpay_order_id = 'order_test_rt_a' where registration_code = 'TEST-RT-A';
-- What razorpay-webhook does on payment.failed (status untouched):
update bookings set payment_status = 'failed', payment_updated_at = now() where razorpay_order_id = 'order_test_rt_a' and status = 'pending';
select tt.check((tt.b('TEST-RT-A')).status = 'pending' and (tt.b('TEST-RT-A')).payment_status = 'failed', 'hold pending, payment_status failed');
select tt.check(tt.err($$select tt.hold('00000000-0000-0000-0000-0000000e7e02', 'TEST-RT-B', 1)$$) like '%SOLD_OUT%', 'buyer B cannot take the seats while A retries');

\echo '--- 2. "Try again" resumes the same order; the retry settles normally'
select tt.check((select id = (tt.b('TEST-RT-A')).id and razorpay_order_id = 'order_test_rt_a' from tt.hold('00000000-0000-0000-0000-0000000e7e01', 'TEST-RT-A2', 2)),
  'the same checkout again resumes the hold and its order (0037), no second hold');
select tt.check((settle_payment('order_test_rt_a', 'pay_test_rt_ok', 118000, 'webhook')) ->> 'result' = 'confirmed', 'the retry payment confirms (not needs_review, not late)');
select tt.check((tt.b('TEST-RT-A')).status = 'confirmed' and (tt.b('TEST-RT-A')).payment_status = 'captured'
  and (select count(*) from tickets where booking_id = (tt.b('TEST-RT-A')).id) = 2, 'confirmed, captured, 2 tickets issued');
select tt.check((settle_payment('order_test_rt_a', 'pay_test_rt_ok', 118000, 'webhook')) ->> 'result' = 'already_confirmed', 'redelivery → already_confirmed (idempotent)');
-- A stale payment.failed after the capture matches nothing:
update bookings set payment_status = 'failed' where razorpay_order_id = 'order_test_rt_a' and status = 'pending';
select tt.check((tt.b('TEST-RT-A')).payment_status = 'captured', 'a late payment.failed cannot touch the confirmed booking');

\echo '--- 3. an abandoned failed hold still expires on the normal timeout'
reset role;
update events set capacity = 4 where id = '00000000-0000-0000-0000-0000000e7ee1';
set local role service_role;
select tt.check((tt.hold('00000000-0000-0000-0000-0000000e7e02', 'TEST-RT-C', 1)).status = 'pending', 'buyer B places a hold');
reset role;
update bookings set razorpay_order_id = 'order_test_rt_c', payment_status = 'failed',
  created_at = now() - make_interval(mins => setting_number('bookings.pending_timeout_minutes', 30)::int + 1)
 where registration_code = 'TEST-RT-C';
select expire_stale_bookings();
select tt.check((tt.b('TEST-RT-C')).status = 'expired', 'failed attempt + timeout → expired, seats released (expire_stale_bookings unchanged)');
select tt.check((settle_payment('order_test_rt_c', 'pay_test_rt_late', 59000, 'webhook')) ->> 'result' = 'confirmed'
  and ((settle_payment('order_test_rt_c', 'pay_test_rt_late', 59000, 'webhook')) ->> 'result') = 'already_confirmed',
  'a payment after expiry with seats still free → late-accepted as before');

\echo ''
\echo 'ALL PAYMENT RETRY DATABASE TESTS PASSED'
rollback;
