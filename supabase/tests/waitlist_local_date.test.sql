-- Tangy Sessions — the waitlist closes on the session's own local date (0044).
-- Real clock; dates relative to each event's own local "today", like
-- past_event_booking.test.sql. Test-owned rows only; rolled back.
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
create function tt.login(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant usage on schema tt to authenticated;
grant execute on all functions in schema tt to authenticated;

insert into auth.users (id, email, aud, role) values ('00000000-0000-0000-0000-0000000c4401', 'test-wl@tz.tangy.test', 'authenticated', 'authenticated');
-- All sold out (status), so only the date rule decides.
insert into events (id, slug, name, event_date, timezone, capacity, price, status) values
  ('00000000-0000-0000-0000-0000000c44e1', 'test-wl-la-today', 'LA today', (now() at time zone 'America/Los_Angeles')::date, 'America/Los_Angeles', 10, 500, 'sold-out'),
  ('00000000-0000-0000-0000-0000000c44e2', 'test-wl-kir-yday', 'Kiritimati yesterday', (now() at time zone 'Pacific/Kiritimati')::date - 1, 'Pacific/Kiritimati', 10, 500, 'sold-out'),
  ('00000000-0000-0000-0000-0000000c44e3', 'test-wl-ist-yday', 'IST yesterday', (now() at time zone 'Asia/Kolkata')::date - 1, 'Asia/Kolkata', 10, 500, 'sold-out'),
  ('00000000-0000-0000-0000-0000000c44e4', 'test-wl-ist-today', 'IST today', (now() at time zone 'Asia/Kolkata')::date, 'Asia/Kolkata', 10, 500, 'sold-out');
select tt.login('00000000-0000-0000-0000-0000000c4401');
select tt.check((join_waitlist('00000000-0000-0000-0000-0000000c44e1', 1)) ->> 'status' = 'waiting', 'a session today in Los Angeles takes waitlist entries, whatever the UTC date');
select tt.check(tt.err($$select join_waitlist('00000000-0000-0000-0000-0000000c44e2', 1)$$) like '%WAITLIST_CLOSED%', 'yesterday in Kiritimati is closed, whatever the UTC date');
select tt.check(tt.err($$select join_waitlist('00000000-0000-0000-0000-0000000c44e3', 1)$$) like '%WAITLIST_CLOSED%', 'yesterday in India is closed (incl. 00:00–05:30 IST, when UTC still says the event date)');
select tt.check((join_waitlist('00000000-0000-0000-0000-0000000c44e4', 1)) ->> 'status' = 'waiting', 'today in India is open');
select set_config('role', 'postgres', true);
select tt.check((select offer_waitlist_seats('00000000-0000-0000-0000-0000000c44e2')) is not distinct from (select offer_waitlist_seats('00000000-0000-0000-0000-0000000c44e2')), 'offer_waitlist_seats runs for a closed session without offering (same rule)');
select tt.check(not exists (select 1 from waitlist where event_id = '00000000-0000-0000-0000-0000000c44e2'), '...and nothing was offered or queued there');

\echo ''
\echo 'ALL WAITLIST LOCAL DATE DATABASE TESTS PASSED'
rollback;
