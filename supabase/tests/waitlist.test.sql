-- Tangy Sessions — server-authoritative waitlist (0027).
-- One transaction, rolled back at the end. Run: scripts/test-db.sh

\set ON_ERROR_STOP 1
\set QUIET 1
begin;

delete from bookings; delete from waitlist; delete from collaborations; delete from crew_applications;
delete from private_enquiries; delete from contact_enquiries;
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
-- Checkout as the Edge Function does it (service role, customer path).
create function tt.book(p_user uuid, p_code text, p_qty int, p_event uuid default '00000000-0000-0000-0000-00000000b601')
returns bookings language sql as $$
  select create_pending_booking(p_user, p_event, p_code, 'Guest', 'g@wl.tangy.test', null,
         p_qty, 1, 'gen', 'order_' || p_code, (select array_agg('Guest ' || g) from generate_series(1, p_qty) g), '{}'::jsonb);
$$;
create function tt.wl(p_user uuid) returns text language sql security definer as $$
  select status from waitlist where user_id = p_user and event_id = '00000000-0000-0000-0000-00000000b601' order by created_at desc limit 1;
$$;
create function tt.notes(p_uid uuid, p_type text) returns bigint language sql security definer as $$
  select count(*) from notifications where user_id = p_uid and type = p_type;
$$;
grant usage on schema tt to anon, authenticated;
grant execute on all functions in schema tt to anon, authenticated;

insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000b500', 'admin@wl.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Mira Manager"}'),
  ('00000000-0000-0000-0000-00000000b501', 'ana@wl.tangy.test',   'authenticated', 'authenticated', '{"full_name":"Ana"}'),
  ('00000000-0000-0000-0000-00000000b502', 'ben@wl.tangy.test',   'authenticated', 'authenticated', '{"full_name":"Ben"}'),
  ('00000000-0000-0000-0000-00000000b503', 'cai@wl.tangy.test',   'authenticated', 'authenticated', '{"full_name":"Cai"}'),
  ('00000000-0000-0000-0000-00000000b504', 'dev@wl.tangy.test',   'authenticated', 'authenticated', '{"full_name":"Dev"}'),
  ('00000000-0000-0000-0000-00000000b505', 'eli@wl.tangy.test',   'authenticated', 'authenticated', '{"full_name":"Eli"}'),
  ('00000000-0000-0000-0000-00000000b509', 'buyer@wl.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Buyer"}'),
  ('00000000-0000-0000-0000-00000000b50a', 'buyer2@wl.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Second Buyer"}');
update profiles set role = 'admin' where id = '00000000-0000-0000-0000-00000000b500';

insert into events (id, slug, name, event_date, venue, capacity, price, status, booking_max_quantity) values
  ('00000000-0000-0000-0000-00000000b601', 'wl-night', 'Waitlist Night', current_date + 5, 'Stepwell', 4, 1000, 'on-sale', 6),
  ('00000000-0000-0000-0000-00000000b602', 'wl-draft', 'Draft Night', current_date + 9, 'Baradari', 4, 1000, 'draft', 6);

\echo '--- 1. Joining'
select tt.anon();
select tt.expect_error($$select join_waitlist('00000000-0000-0000-0000-00000000b601', 1)$$, '%permission denied%', 'signed-out visitors cannot join');
select tt.expect_error($$insert into waitlist (event_id, name, email) values ('00000000-0000-0000-0000-00000000b601', 'Anon', 'a@x.test')$$, '%row-level security%', 'anonymous direct inserts are gone');
select tt.login('00000000-0000-0000-0000-00000000b501');
select tt.expect_error($$select join_waitlist('00000000-0000-0000-0000-00000000b601', 1)$$, '%SEATS_AVAILABLE%', 'no waitlist while seats are available');
select tt.expect_error($$select join_waitlist('00000000-0000-0000-0000-00000000b602', 1)$$, '%WAITLIST_CLOSED%', 'draft sessions take no waitlist');
select tt.expect_error($$insert into waitlist (event_id, user_id, name, email, status) values ('00000000-0000-0000-0000-00000000b601', auth.uid(), 'Ana', 'ana@wl.tangy.test', 'offered')$$, '%row-level security%', 'members cannot write waitlist rows directly (no self-offers)');
select tt.logout();
select tt.book('00000000-0000-0000-0000-00000000b509', 'W-B1', 2);
-- Two customers fill the session (one account holds one checkout at a time — 0037).
select tt.book('00000000-0000-0000-0000-00000000b50a', 'W-B2', 2);
insert into waitlist (event_id, name, email) values ('00000000-0000-0000-0000-00000000b601', 'Legacy Walk-in', 'legacy@x.test');

select tt.login('00000000-0000-0000-0000-00000000b501');
select tt.expect_error($$select join_waitlist('00000000-0000-0000-0000-00000000b601', 9)$$, '%INVALID_QUANTITY%', 'party size limited to the session''s booking range');
select tt.check((select (join_waitlist('00000000-0000-0000-0000-00000000b601', 2) ->> 'position')::int = 1), 'Ana joins for 2 — position 1');
select tt.expect_error($$select join_waitlist('00000000-0000-0000-0000-00000000b601', 1)$$, '%ALREADY_WAITLISTED%', 'joining twice is refused');
select tt.login('00000000-0000-0000-0000-00000000b502');
select tt.check((select (join_waitlist('00000000-0000-0000-0000-00000000b601', 1) ->> 'position')::int = 2), 'Ben joins for 1 — position 2');
select tt.login('00000000-0000-0000-0000-00000000b503');
select tt.check((select (join_waitlist('00000000-0000-0000-0000-00000000b601', 1) ->> 'position')::int = 3), 'Cai joins for 1 — position 3');
select tt.check((select count(*) = 1 from waitlist), 'members see only their own entry');
select tt.check((select queue_position = 3 and status = 'waiting' from my_waitlist()), 'my_waitlist shows Cai''s position');
select tt.check((select (a ->> 'waitlist')::int = 3 and (a ->> 'remaining')::int = 0 from (select event_availability('00000000-0000-0000-0000-00000000b601') a) x),
  'availability: sold out, 3 waiting (the legacy anonymous row isn''t counted)');
select tt.logout();
select tt.check(tt.notes('00000000-0000-0000-0000-00000000b501', 'waitlist.joined') = 1, 'joining sends a receipt');

\echo '--- 2. A cancellation offers the seats to the head of the queue'
update bookings set status = 'cancelled' where registration_code = 'W-B1';
select tt.check(tt.wl('00000000-0000-0000-0000-00000000b501') = 'offered', 'Ana (2 seats) is offered the 2 released seats');
select tt.check((select offer_expires_at between now() + interval '119 minutes' and now() + interval '121 minutes' from waitlist where user_id = '00000000-0000-0000-0000-00000000b501'),
  'the offer is held for the configured 120 minutes');
select tt.check(tt.wl('00000000-0000-0000-0000-00000000b502') = 'waiting' and tt.wl('00000000-0000-0000-0000-00000000b503') = 'waiting', 'Ben and Cai keep waiting');
select tt.check(tt.notes('00000000-0000-0000-0000-00000000b501', 'waitlist.offer') = 1
  and (select link = '/sessions/wl-night' from notifications where type = 'waitlist.offer'), 'Ana is notified with a link to the session');
select tt.check((select count(*) >= 1 from email_outbox where notification_type = 'waitlist.offer'), 'an offer email is queued (sent once email is configured)');
select tt.check((select status = 'waiting' from waitlist where user_id is null), 'the legacy anonymous row is never auto-offered');
select tt.check((select (event_availability('00000000-0000-0000-0000-00000000b601') ->> 'remaining')::int = 0), 'held seats are not shown as available');
select tt.check(offer_waitlist_seats('00000000-0000-0000-0000-00000000b601') = 0 and (select count(*) = 1 from waitlist where status = 'offered'),
  're-running the offer engine is idempotent (no second offer for the same seats)');
select tt.expect_error($$select tt.book('00000000-0000-0000-0000-00000000b509', 'W-SNIPE', 1)$$, '%SOLD_OUT%', 'someone else cannot take the held seats');
select tt.expect_error($$select tt.book('00000000-0000-0000-0000-00000000b502', 'W-BEN', 1)$$, '%SOLD_OUT%', 'the next person in line cannot take them either');
select tt.expect_error($$select tt.book('00000000-0000-0000-0000-00000000b501', 'W-ANA3', 3)$$, '%SOLD_OUT%', 'the holder cannot book more than was held');

\echo '--- 3. Conversion'
select tt.book('00000000-0000-0000-0000-00000000b501', 'W-ANA', 2);
select tt.check(tt.wl('00000000-0000-0000-0000-00000000b501') = 'converted'
  and (select w.booking_id = b.id and b.waitlist_entry_id = w.id from waitlist w join bookings b on b.registration_code = 'W-ANA' where w.user_id = '00000000-0000-0000-0000-00000000b501'),
  'Ana''s checkout converts the offer and links the booking');
select tt.check((select count(*) = 1 from audit_logs where action = 'waitlist.converted'), 'conversion is audited');
select tt.check((select sum(quantity) = 4 from bookings where event_id = '00000000-0000-0000-0000-00000000b601' and status in ('pending', 'confirmed')), 'capacity is never exceeded (4 of 4)');

\echo '--- 4. Capacity increase, declining, expiry'
update events set capacity = 5 where id = '00000000-0000-0000-0000-00000000b601';
select tt.check(tt.wl('00000000-0000-0000-0000-00000000b502') = 'offered' and tt.wl('00000000-0000-0000-0000-00000000b503') = 'waiting', 'raising capacity by 1 offers Ben');
select tt.login('00000000-0000-0000-0000-00000000b502');
select leave_waitlist('00000000-0000-0000-0000-00000000b601');
select tt.check(tt.wl('00000000-0000-0000-0000-00000000b502') = 'cancelled', 'Ben declines');
select tt.expect_error($$select leave_waitlist('00000000-0000-0000-0000-00000000b601')$$, '%not on the waitlist%', 'leaving twice is refused');
select tt.logout();
select tt.check(tt.wl('00000000-0000-0000-0000-00000000b503') = 'offered', 'the declined seat passes to Cai');
update waitlist set offer_expires_at = now() - interval '1 minute', offered_at = now() - interval '3 hours' where user_id = '00000000-0000-0000-0000-00000000b503';
select tt.login('00000000-0000-0000-0000-00000000b503');
select tt.check((select status = 'expired' from my_waitlist()), 'a lapsed offer shows as expired straight away');
select tt.logout();
select tt.check(expire_waitlist_offers() = 1 and tt.wl('00000000-0000-0000-0000-00000000b503') = 'expired', 'the scheduled job expires the lapsed offer');
select tt.check(tt.notes('00000000-0000-0000-0000-00000000b503', 'waitlist.offer_expired') = 1, 'Cai is told the hold ran out');
select tt.check(expire_waitlist_offers() = 0, 'expiry is idempotent');

\echo '--- 5. Strict first-come-first-served'
select tt.login('00000000-0000-0000-0000-00000000b504');
select tt.check((select (join_waitlist('00000000-0000-0000-0000-00000000b601', 3) ->> 'position')::int = 1), 'Dev joins for 3 while only 1 seat is free');
select tt.login('00000000-0000-0000-0000-00000000b505');
select tt.check((select (join_waitlist('00000000-0000-0000-0000-00000000b601', 1) ->> 'position')::int = 2), 'Eli may queue behind Dev even though 1 seat is free');
select tt.logout();
select tt.check(offer_waitlist_seats('00000000-0000-0000-0000-00000000b601') = 0
  and tt.wl('00000000-0000-0000-0000-00000000b504') = 'waiting' and tt.wl('00000000-0000-0000-0000-00000000b505') = 'waiting',
  'a smaller party never jumps the queue');
update bookings set status = 'cancelled' where registration_code = 'W-B2';
select tt.check(tt.wl('00000000-0000-0000-0000-00000000b504') = 'offered' and tt.wl('00000000-0000-0000-0000-00000000b505') = 'waiting',
  'once 3 seats are free, Dev is offered first');

\echo '--- 6. An abandoned checkout releases seats onwards'
update bookings set status = 'expired', expired_at = now() where registration_code = 'W-ANA';
select tt.check(tt.wl('00000000-0000-0000-0000-00000000b505') = 'offered', 'Ana''s expired checkout passes a seat to Eli');
select tt.check((select coalesce(sum(quantity), 0) from bookings where event_id = '00000000-0000-0000-0000-00000000b601' and status in ('pending', 'confirmed'))
  + waitlist_held_seats('00000000-0000-0000-0000-00000000b601') <= 5, 'booked + held seats never exceed capacity');

\echo '--- 7. A late payment cannot take held seats'
select tt.check((select settle_payment('order_W-ANA', 'pay_late', null, 'webhook') ->> 'result') = 'needs_review', 'Ana paying after expiry goes to review (seats are held for others)');
select tt.check(tt.wl('00000000-0000-0000-0000-00000000b504') = 'offered' and tt.wl('00000000-0000-0000-0000-00000000b505') = 'offered', 'the offers stand');

\echo '--- 8. Who can do what'
select tt.login('00000000-0000-0000-0000-00000000b503');
select tt.expect_error($$select admin_offer_waitlist('00000000-0000-0000-0000-00000000b601')$$, '%permission%', 'a customer cannot trigger offers');
select tt.expect_error($$select offer_waitlist_seats('00000000-0000-0000-0000-00000000b601')$$, '%permission denied%', 'the offer engine is not callable by clients');
select tt.expect_error($$select expire_waitlist_offers()$$, '%permission denied%', 'nor is expiry');
with u as (update waitlist set status = 'offered', offered_at = now(), offer_expires_at = now() + interval '1 day' returning id)
select tt.check(not exists (select 1 from u), 'members cannot edit their own entry');
select tt.login('00000000-0000-0000-0000-00000000b500');
select tt.check((select count(*) = 6 from waitlist), 'the team sees the whole waitlist (including the legacy row)');
select tt.check(admin_offer_waitlist('00000000-0000-0000-0000-00000000b601') = 0, 'an admin can run the offer engine (nothing more to offer)');
select admin_remove_waitlist_entry((select id from waitlist where user_id = '00000000-0000-0000-0000-00000000b505'), 'duplicate');
select tt.check(tt.wl('00000000-0000-0000-0000-00000000b505') = 'skipped', 'an admin can remove an entry (Eli''s held offer)');
select tt.logout();
select tt.check((select count(*) = 1 from audit_logs where action = 'waitlist.removed' and metadata ->> 'reason' = 'duplicate'
  and actor_id = '00000000-0000-0000-0000-00000000b500'), 'removal is audited with the admin and the reason');
select tt.login('00000000-0000-0000-0000-00000000b500');
select tt.expect_error($$select admin_remove_waitlist_entry((select id from waitlist where user_id = '00000000-0000-0000-0000-00000000b505'))$$, '%no longer active%', 'removing twice is refused');
select tt.login('00000000-0000-0000-0000-00000000b503');
select tt.expect_error($$select admin_remove_waitlist_entry((select id from waitlist limit 1))$$, '%permission%', 'a customer cannot remove entries');
select tt.login('00000000-0000-0000-0000-00000000b500');
select tt.logout();
select tt.check((select run_platform_jobs() ? 'waitlist_offers_expired'), 'the scheduled jobs include offer expiry');

\echo ''
\echo 'ALL WAITLIST DATABASE TESTS PASSED'
rollback;
