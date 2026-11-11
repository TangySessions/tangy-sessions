-- Tangy Sessions — ticket email through email_outbox (no new database object).
--
-- The Edge Functions (supabase/functions/_shared/ticketEmail.ts) queue one
-- 'ticket.confirmed' row per booking with the service role once
-- settle_payment has confirmed it, and send-notification-emails delivers it.
-- This suite checks the existing schema and functions behave the way that
-- code relies on (scripts/test-ticket-email.mjs exercises the code itself).
-- Test-owned rows only; one transaction, rolled back.
-- Run: scripts/test-db.sh / scripts/test-db-local.sh

\set ON_ERROR_STOP 1
\set QUIET 1
begin;
-- claim_email_batch hands out the OLDEST queued rows first. On a local
-- database with no email provider, earlier runs leave queued rows behind,
-- so the batch would never reach this suite's rows. Start from an empty
-- outbox inside this transaction (rolled back at the end, like the other
-- suites that clear email_outbox).
delete from email_outbox;

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
create function tt.as_user(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function tt.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;
create function tt.as_owner() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
grant usage on schema tt to anon, authenticated, service_role;

insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000ce001', 'test-buyer@ticketmail.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Buyer"}'),
  ('00000000-0000-0000-0000-0000000ce002', 'test-other@ticketmail.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Other"}');
insert into events (id, slug, name, event_date, capacity, price, status) values
  ('00000000-0000-0000-0000-0000000ce0e1', 'test-ticketmail', 'Test Ticket Mail Night', current_date + 14, 40, 500, 'on-sale');
insert into bookings (id, registration_code, user_id, event_id, attendee_name, attendee_email, quantity, amount, status, razorpay_order_id) values
  ('00000000-0000-0000-0000-0000000ceb01', 'TEST-TM1', '00000000-0000-0000-0000-0000000ce001', '00000000-0000-0000-0000-0000000ce0e1',
   'Test Buyer', 'typed@ticketmail.tangy.test', 2, 1180, 'pending', 'order_test_tm1');

\echo '--- 1. settle_payment reports the booking it confirmed (the webhook queues by this id)'
select tt.as_service();
select tt.check((select settle_payment('order_test_tm1', 'pay_test_tm1', 118000, 'webhook')) ->> 'result' = 'confirmed', 'first settlement: confirmed');
select tt.check((select settle_payment('order_test_tm1', 'pay_test_tm1', 118000, 'webhook')) ->> 'booking_id' = '00000000-0000-0000-0000-0000000ceb01', 'repeat settlement: already_confirmed with the same booking_id');
select tt.check((select count(*) from tickets where booking_id = '00000000-0000-0000-0000-0000000ceb01') = 2, 'tickets issued once, server-side');
select tt.check((select ticket_email_status from bookings where id = '00000000-0000-0000-0000-0000000ceb01') = 'pending', 'settlement leaves the ticket email pending (it sends nothing itself)');

\echo '--- 2. one queued ticket email per booking'
insert into email_outbox (user_id, to_email, notification_type, subject, body, link, dedupe_key)
values ('00000000-0000-0000-0000-0000000ce001', 'test-buyer@ticketmail.tangy.test', 'ticket.confirmed', 'Your Tangy Sessions tickets — TEST-TM1', null, null,
        'ticket.confirmed:00000000-0000-0000-0000-0000000ceb01');
select tt.check((select status from email_outbox where dedupe_key = 'ticket.confirmed:00000000-0000-0000-0000-0000000ceb01') = 'queued', 'service role queues the ticket email (no body / link needed)');
select tt.expect_error($$insert into email_outbox (user_id, to_email, notification_type, subject, dedupe_key)
  values ('00000000-0000-0000-0000-0000000ce001', 'test-buyer@ticketmail.tangy.test', 'ticket.confirmed', 'dup', 'ticket.confirmed:00000000-0000-0000-0000-0000000ceb01')$$,
  '%duplicate key%', 'a second queue attempt for the same booking is refused (unique dedupe_key → 23505)');

\echo '--- 3. API users cannot queue or read ticket emails'
select tt.as_user('00000000-0000-0000-0000-0000000ce001');
select tt.expect_error($$insert into email_outbox (user_id, to_email, notification_type, subject, dedupe_key)
  values (auth.uid(), 'x@x.test', 'ticket.confirmed', 'forged', 'ticket.confirmed:forged')$$, '%row-level security%', 'a signed-in customer cannot queue an email');
select tt.check(not exists (select 1 from email_outbox where notification_type = 'ticket.confirmed'), 'a customer cannot read the email queue');
select tt.expect_error($$select claim_email_batch(5)$$, '%permission denied%', 'a customer cannot claim queued emails');

\echo '--- 4. the drain: claim, fail and retry, deliver'
select tt.as_service();
select tt.check((select count(*) from claim_email_batch(25) c where c.dedupe_key = 'ticket.confirmed:00000000-0000-0000-0000-0000000ceb01' and c.notification_type = 'ticket.confirmed') = 1, 'claim_email_batch hands the ticket row to the drain');
select tt.check((select count(*) from claim_email_batch(25) c where c.notification_type = 'ticket.confirmed') = 0, 'a claimed row is not handed out twice');
select complete_email((select id from email_outbox where dedupe_key = 'ticket.confirmed:00000000-0000-0000-0000-0000000ceb01'), false, 'Email provider rejected the message.');
update bookings set ticket_email_status = 'failed', ticket_email_error = 'Email provider rejected the message.' where id = '00000000-0000-0000-0000-0000000ceb01';
select tt.check((select status from email_outbox where dedupe_key = 'ticket.confirmed:00000000-0000-0000-0000-0000000ceb01') = 'queued', 'provider failure: back in the queue for a retry');
select tt.check((select status::text from bookings where id = '00000000-0000-0000-0000-0000000ceb01') = 'confirmed'
  and (select payment_status from bookings where id = '00000000-0000-0000-0000-0000000ceb01') = 'captured', 'an email failure leaves the booking confirmed and captured');
select complete_email((select id from claim_email_batch(25) c where c.notification_type = 'ticket.confirmed'), true, null);
update bookings set ticket_email_status = 'sent', ticket_email_sent_at = now(), ticket_email_error = null where id = '00000000-0000-0000-0000-0000000ceb01';
select tt.check((select status from email_outbox where dedupe_key = 'ticket.confirmed:00000000-0000-0000-0000-0000000ceb01') = 'sent'
  and (select ticket_email_status from bookings where id = '00000000-0000-0000-0000-0000000ceb01') = 'sent', 'retry delivered: outbox sent, booking ticket_email_status sent');

\echo '--- 5. exhausted retries and skipped rows'
insert into email_outbox (to_email, notification_type, subject, dedupe_key, attempts) values ('t@ticketmail.tangy.test', 'ticket.confirmed', 's', 'ticket.confirmed:test-exhaust', 4);
select complete_email((select id from claim_email_batch(25) c where c.dedupe_key = 'ticket.confirmed:test-exhaust'), false, 'x');
select tt.check((select status from email_outbox where dedupe_key = 'ticket.confirmed:test-exhaust') = 'failed', 'after 5 attempts the row is failed (admin resends from Bookings)');
select tt.check((select count(*) from claim_email_batch(25) c where c.dedupe_key = 'ticket.confirmed:test-exhaust') = 0, 'a failed row is not claimed again');
insert into email_outbox (to_email, notification_type, subject, dedupe_key) values ('t@ticketmail.tangy.test', 'ticket.confirmed', 's', 'ticket.confirmed:test-skip');
update email_outbox set status = 'skipped', locked_at = null, last_error = 'Ticket email already sent.' where dedupe_key = 'ticket.confirmed:test-skip';
select tt.check((select status from email_outbox where dedupe_key = 'ticket.confirmed:test-skip') = 'skipped'
  and (select count(*) from claim_email_batch(25) c where c.dedupe_key = 'ticket.confirmed:test-skip') = 0, 'a skipped row (already delivered) is never claimed');
select tt.as_owner();

\echo ''
\echo 'ALL TICKET EMAIL OUTBOX DATABASE TESTS PASSED'
rollback;
