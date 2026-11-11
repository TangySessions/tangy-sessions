-- Tangy Sessions — no ₹0 ticket types (0039).
--
-- Writes go straight to event_ticket_types under RLS (the admin editor) or
-- with the service role, so the database is the check. Prices are whole
-- rupees (integer); checkout charges price × people + 18% GST, in paise.
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
-- The error a write raises, with its SQLSTATE (null if it succeeded).
create function tt.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
create function tt.price(p_code text) returns int language sql security definer set search_path = public as $$
  select price from event_ticket_types where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = p_code;
$$;
grant usage on schema tt to anon, authenticated, service_role;
grant execute on all functions in schema tt to anon, authenticated, service_role;

insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000fe001', 'test-admin@price0.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Admin"}'),
  ('00000000-0000-0000-0000-0000000fe002', 'test-staff@price0.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Staff"}'),
  ('00000000-0000-0000-0000-0000000fe003', 'test-pat@price0.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Patron"}');
update profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000fe001';
update profiles set role = 'staff' where id = '00000000-0000-0000-0000-0000000fe002';
insert into events (id, slug, name, event_date, capacity, price, status) values
  ('00000000-0000-0000-0000-0000000fe0e1', 'test-price0', 'Test Price Night', current_date + 12, 40, 700, 'on-sale');

\echo '--- 1. positive prices work exactly as before'
select tt.check(tt.price('gen') = 700, 'a new event with a price still gets General Admission at that price');
select tt.as_user('00000000-0000-0000-0000-0000000fe001');
insert into event_ticket_types (event_id, code, name, price, sort_order) values ('00000000-0000-0000-0000-0000000fe0e1', 'vip', 'VIP', 1500, 2);
select tt.check(tt.price('vip') = 1500, 'an admin adds a ₹1,500 type');
update event_ticket_types set price = 1600, name = 'VIP Plus' where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'vip';
select tt.check(tt.price('vip') = 1600, 'an admin changes a positive price');
update event_ticket_types set active = false where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'vip';
update event_ticket_types set active = true where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'vip';
select tt.check((select active from event_ticket_types where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'vip'), 'a positive type can be taken off sale and put back');
select tt.check((select b ->> 'total' = '1652' and b ->> 'tax' = '252' from (select booking_quote('00000000-0000-0000-0000-0000000fe0e1', 'gen', 2) b) x),
  'quote unchanged: ₹700 × 2 = ₹1,400 + 18% = ₹1,652');

\echo '--- 2. ₹0 is refused for admins (the editor path)'
select tt.check(tt.err($$insert into event_ticket_types (event_id, code, name, price) values ('00000000-0000-0000-0000-0000000fe0e1', 'free', 'Free', 0)$$)
  like '23514 A ticket price must be at least ₹1%', 'creating a ₹0 type is refused (23514, readable message)');
select tt.check(tt.err($$insert into event_ticket_types (event_id, code, name, price, active) values ('00000000-0000-0000-0000-0000000fe0e1', 'free', 'Free', 0, false)$$)
  like '23514%at least ₹1%', 'even off sale');
select tt.check(tt.err($$update event_ticket_types set price = 0 where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'vip'$$)
  like '23514%at least ₹1%', 'changing a priced type to ₹0 is refused');
select tt.check(tt.price('vip') = 1600, '...and the price is unchanged');
select tt.check(tt.err($$insert into event_ticket_types (event_id, code, name, price) values ('00000000-0000-0000-0000-0000000fe0e1', 'neg', 'Negative', -100)$$)
  like '23514%', 'a negative price is refused');
select tt.check(tt.err($$update event_ticket_types set price = -1 where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'vip'$$)
  like '23514%', 'changing to a negative price is refused');
select tt.check(tt.err($$update event_ticket_types set price = 1000001 where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'vip'$$)
  like '23514%event_ticket_types_price_check%', 'the existing ₹10,00,000 ceiling still applies');
select tt.check(tt.err($$insert into event_ticket_types (event_id, code, name, price) values ('00000000-0000-0000-0000-0000000fe0e1', 'zz', 'Z', 0)$$)
  !~* 'event_ticket_types|enforce_|price_min|trigger|function', 'the message names no table, trigger or function');

\echo '--- 3. precision: whole rupees, ₹1 is the floor'
select tt.as_user('00000000-0000-0000-0000-0000000fe001');
insert into event_ticket_types (event_id, code, name, price, sort_order) values ('00000000-0000-0000-0000-0000000fe0e1', 'one', 'One rupee', 1, 3);
select tt.check(tt.price('one') = 1, '₹1 is accepted');
select tt.check((select b ->> 'total' = '1' and b ->> 'tax' = '0' from (select booking_quote('00000000-0000-0000-0000-0000000fe0e1', 'one', 1) b) x),
  '₹1 quotes to ₹1 = 100 paise, Razorpay''s minimum');
select tt.check(tt.err($$update event_ticket_types set price = 0.4 where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'one'$$)
  like '23514%', '₹0.40 rounds to ₹0 in the integer column → refused, cannot slip through as a fraction');
update event_ticket_types set price = 0.6 where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'one';
select tt.check(tt.price('one') = 1, '₹0.60 rounds to ₹1 (integer rupees) → accepted as ₹1');
-- What PostgREST does with a JSON body: a fractional number is not an integer.
select tt.check(tt.err($$insert into event_ticket_types (event_id, code, name, price)
  select '00000000-0000-0000-0000-0000000fe0e1', 'frac', 'Frac', r.price from json_populate_record(null::event_ticket_types, '{"price": 499.5}') r$$)
  like '22P02%', 'an API body with price 499.5 is rejected as not an integer');
select tt.check(tt.err($$insert into event_ticket_types (event_id, code, name, price)
  select '00000000-0000-0000-0000-0000000fe0e1', 'frac', 'Frac', r.price from json_populate_record(null::event_ticket_types, '{"price": 0}') r$$)
  like '23514%', 'an API body with price 0 is refused');

\echo '--- 4. every path is checked, permissions unchanged'
select tt.as_service();
select tt.check(tt.err($$insert into event_ticket_types (event_id, code, name, price) values ('00000000-0000-0000-0000-0000000fe0e1', 'svc', 'Svc', 0)$$)
  like '23514%', 'the service role cannot create a ₹0 type either');
select tt.as_owner();
select tt.check(tt.err($$update event_ticket_types set price = 0 where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'gen'$$)
  like '23514%', 'nor the table owner (SQL editor)');
select tt.as_user('00000000-0000-0000-0000-0000000fe002');
select tt.check(tt.err($$insert into event_ticket_types (event_id, code, name, price) values ('00000000-0000-0000-0000-0000000fe0e1', 'stf', 'Staff', 900)$$)
  like '%row-level security%', 'staff still cannot add ticket types (RLS unchanged)');
with u as (update event_ticket_types set price = 5 where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'gen' returning id)
select tt.check(not exists (select 1 from u), 'staff still cannot change prices');
select tt.as_user('00000000-0000-0000-0000-0000000fe003');
select tt.check(tt.err($$insert into event_ticket_types (event_id, code, name, price) values ('00000000-0000-0000-0000-0000000fe0e1', 'pat', 'Patron', 900)$$)
  like '%row-level security%', 'a customer still cannot add ticket types');
select tt.as_owner();
select tt.check(tt.price('gen') = 700, 'General Admission untouched by all of the above');

\echo '--- 5. new events without a price get no ₹0 type'
insert into events (id, slug, name, event_date, capacity, status) values
  ('00000000-0000-0000-0000-0000000fe0e2', 'test-price0-none', 'No Price Yet', current_date + 20, 40, 'draft');
select tt.check(not exists (select 1 from event_ticket_types where event_id = '00000000-0000-0000-0000-0000000fe0e2'),
  'an event created without a price is created, with no ticket type (not a ₹0 one)');
insert into events (id, slug, name, event_date, capacity, price, status) values
  ('00000000-0000-0000-0000-0000000fe0e3', 'test-price0-zero', 'Zero Price', current_date + 20, 40, 0, 'draft');
select tt.check(not exists (select 1 from event_ticket_types where event_id = '00000000-0000-0000-0000-0000000fe0e3'), 'same for an explicit ₹0');

\echo '--- 6. a legacy ₹0 type (created before 0039) is left alone and can be retired'
alter table event_ticket_types disable trigger event_ticket_types_price_min;
insert into event_ticket_types (event_id, code, name, price, sort_order) values ('00000000-0000-0000-0000-0000000fe0e1', 'legacy', 'Old free type', 0, 9);
alter table event_ticket_types enable trigger event_ticket_types_price_min;
select tt.as_user('00000000-0000-0000-0000-0000000fe001');
update event_ticket_types set name = 'Old free type (renamed)' where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'legacy';
select tt.check((select name = 'Old free type (renamed)' and price = 0 from event_ticket_types where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'legacy'),
  'it can still be edited without touching its price');
update event_ticket_types set active = false where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'legacy';
select tt.check((select not active from event_ticket_types where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'legacy'), 'it can be taken off sale');
select tt.check(tt.err($$update event_ticket_types set active = true where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'legacy'$$)
  like '23514%', 'it cannot be put back on sale at ₹0');
update event_ticket_types set price = 300, active = true where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'legacy';
select tt.check(tt.price('legacy') = 300, 'giving it a price puts it back on sale');
delete from event_ticket_types where event_id = '00000000-0000-0000-0000-0000000fe0e1' and code = 'legacy';
select tt.check(tt.price('legacy') is null, 'an unsold type can still be deleted');

\echo '--- 7. checkout on a positive type is unchanged'
select tt.as_service();
select tt.check((select amount = 1652 and status::text = 'pending' and tier = 'gen' from create_pending_booking(
  '00000000-0000-0000-0000-0000000fe003', '00000000-0000-0000-0000-0000000fe0e1', 'TEST-P0-1', 'Test Patron', 'test-pat@price0.tangy.test', '9876543210',
  2, null, 'gen', null, array['Guest 1', 'Guest 2'], '{"answers":{}}'::jsonb)), 'a ₹700 × 2 checkout holds ₹1,652 as before');
select tt.as_owner();
update bookings set razorpay_order_id = 'order_test_p0_1' where registration_code = 'TEST-P0-1';
select tt.as_service();
select tt.check((settle_payment('order_test_p0_1', 'pay_test_p0_1', 165200, 'webhook')) ->> 'result' = 'confirmed', 'and settles at 165200 paise');
select tt.as_owner();

\echo ''
\echo 'ALL TICKET PRICE MINIMUM DATABASE TESTS PASSED'
rollback;
