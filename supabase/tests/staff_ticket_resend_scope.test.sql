-- Tangy Sessions — staff are scoped to their assigned events.
--
-- send-ticket-email lets staff resend a booking's ticket email only when
-- is_assigned_to_event(<the booking's event>) is true for them, evaluated
-- under their own session (scripts/test-email-auth.mjs exercises the
-- function). This suite checks that helper on the real schema, and that
-- staff cannot grant themselves an assignment. No new database objects.
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
-- is_assigned_to_event as user p_uid sees it. It returns NULL (not false) for
-- a deactivated account (current_role_name() is NULL); the Edge Function only
-- accepts a literal true, so NULL is a refusal — normalised here.
create function tt.assigned(p_uid uuid, p_event uuid) returns boolean language plpgsql as $$
declare v boolean;
begin
  perform tt.as_user(p_uid);
  v := coalesce(is_assigned_to_event(p_event), false);
  perform tt.as_owner();
  return v;
end $$;
grant usage on schema tt to anon, authenticated, service_role;
grant execute on all functions in schema tt to anon, authenticated, service_role;

insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000f5e01', 'test-admin@scope.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Test Admin"}'),
  ('00000000-0000-0000-0000-0000000f5e02', 'test-staff-a@scope.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Staff A"}'),
  ('00000000-0000-0000-0000-0000000f5e03', 'test-staff-b@scope.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Staff B"}'),
  ('00000000-0000-0000-0000-0000000f5e04', 'test-staff-0@scope.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Staff None"}'),
  ('00000000-0000-0000-0000-0000000f5e05', 'test-vol@scope.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Volunteer"}'),
  ('00000000-0000-0000-0000-0000000f5e06', 'test-pat@scope.tangy.test', 'authenticated', 'authenticated', '{"full_name":"Patron"}');
update profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000f5e01';
update profiles set role = 'staff' where id in ('00000000-0000-0000-0000-0000000f5e02', '00000000-0000-0000-0000-0000000f5e03', '00000000-0000-0000-0000-0000000f5e04');
update profiles set role = 'volunteer' where id = '00000000-0000-0000-0000-0000000f5e05';
insert into events (id, slug, name, event_date, capacity, price, status) values
  ('00000000-0000-0000-0000-0000000f5ea1', 'test-scope-a', 'Event A', current_date + 10, 40, 500, 'on-sale'),
  ('00000000-0000-0000-0000-0000000f5ea2', 'test-scope-b', 'Event B', current_date + 17, 40, 500, 'on-sale');
insert into event_assignments (id, event_id, assignee_role, assignee_id, title, status, assigned_by) values
  ('00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5ea1', 'staff', '00000000-0000-0000-0000-0000000f5e02', 'Gate', 'assigned', '00000000-0000-0000-0000-0000000f5e01'),
  ('00000000-0000-0000-0000-0000000f5a02', '00000000-0000-0000-0000-0000000f5ea2', 'staff', '00000000-0000-0000-0000-0000000f5e03', 'Gate', 'confirmed', '00000000-0000-0000-0000-0000000f5e01'),
  ('00000000-0000-0000-0000-0000000f5a03', '00000000-0000-0000-0000-0000000f5ea1', 'volunteer', '00000000-0000-0000-0000-0000000f5e05', 'Usher', 'confirmed', '00000000-0000-0000-0000-0000000f5e01');
insert into bookings (id, registration_code, user_id, event_id, attendee_name, attendee_email, quantity, amount, status) values
  ('00000000-0000-0000-0000-0000000f5b01', 'TEST-SC-A', '00000000-0000-0000-0000-0000000f5e06', '00000000-0000-0000-0000-0000000f5ea1', 'Patron', 'p@scope.tangy.test', 1, 590, 'confirmed'),
  ('00000000-0000-0000-0000-0000000f5b02', 'TEST-SC-B', '00000000-0000-0000-0000-0000000f5e06', '00000000-0000-0000-0000-0000000f5ea2', 'Patron', 'p@scope.tangy.test', 1, 590, 'confirmed');

\echo '--- 1. is_assigned_to_event: the assignment, nothing else'
select tt.check(tt.assigned('00000000-0000-0000-0000-0000000f5e02', '00000000-0000-0000-0000-0000000f5ea1'), 'staff assigned to A → A');
select tt.check(not tt.assigned('00000000-0000-0000-0000-0000000f5e02', '00000000-0000-0000-0000-0000000f5ea2'), 'staff assigned to A → not B');
select tt.check(tt.assigned('00000000-0000-0000-0000-0000000f5e03', '00000000-0000-0000-0000-0000000f5ea2') and not tt.assigned('00000000-0000-0000-0000-0000000f5e03', '00000000-0000-0000-0000-0000000f5ea1'), 'staff assigned to B → B only');
select tt.check(not tt.assigned('00000000-0000-0000-0000-0000000f5e04', '00000000-0000-0000-0000-0000000f5ea1') and not tt.assigned('00000000-0000-0000-0000-0000000f5e04', '00000000-0000-0000-0000-0000000f5ea2'), 'staff with no assignment → nothing');
select tt.check(not tt.assigned('00000000-0000-0000-0000-0000000f5e05', '00000000-0000-0000-0000-0000000f5ea1'), 'a volunteer slot on A is not a staff assignment');
select tt.check(not tt.assigned('00000000-0000-0000-0000-0000000f5e01', '00000000-0000-0000-0000-0000000f5ea1'), 'admins are not "assigned" (send-ticket-email lets them in by role, not by this)');
select tt.as_service();
select tt.check(not is_assigned_to_event('00000000-0000-0000-0000-0000000f5ea1'), 'no session (service role) → false: it must be asked under the caller''s session');
select tt.as_owner();

\echo '--- 2. multiple assignments, status, removal, deactivation'
insert into event_assignments (event_id, assignee_role, assignee_id, title, status, assigned_by) values
  ('00000000-0000-0000-0000-0000000f5ea2', 'staff', '00000000-0000-0000-0000-0000000f5e02', 'Box office', 'completed', '00000000-0000-0000-0000-0000000f5e01');
select tt.check(tt.assigned('00000000-0000-0000-0000-0000000f5e02', '00000000-0000-0000-0000-0000000f5ea1') and tt.assigned('00000000-0000-0000-0000-0000000f5e02', '00000000-0000-0000-0000-0000000f5ea2'),
  'assigned to A and B (completed) → both');
delete from event_assignments where event_id = '00000000-0000-0000-0000-0000000f5ea2' and assignee_id = '00000000-0000-0000-0000-0000000f5e02';
select tt.check(not tt.assigned('00000000-0000-0000-0000-0000000f5e02', '00000000-0000-0000-0000-0000000f5ea2'), 'assignment removed → B stops immediately');
update event_assignments set status = 'declined' where id = '00000000-0000-0000-0000-0000000f5a02';
select tt.check(not tt.assigned('00000000-0000-0000-0000-0000000f5e03', '00000000-0000-0000-0000-0000000f5ea2'), 'declined assignment → no access');
update event_assignments set status = 'confirmed' where id = '00000000-0000-0000-0000-0000000f5a02';
update profiles set is_active = false where id = '00000000-0000-0000-0000-0000000f5e02';
select tt.as_user('00000000-0000-0000-0000-0000000f5e02');
select tt.check(is_assigned_to_event('00000000-0000-0000-0000-0000000f5ea1') is not true, 'deactivated staff: the helper answers NULL, never true');
select tt.as_owner();
select tt.check(not tt.assigned('00000000-0000-0000-0000-0000000f5e02', '00000000-0000-0000-0000-0000000f5ea1'), 'deactivated staff → false even with the assignment');
update profiles set is_active = true where id = '00000000-0000-0000-0000-0000000f5e02';
select tt.check(tt.assigned('00000000-0000-0000-0000-0000000f5e02', '00000000-0000-0000-0000-0000000f5ea1'), 'reactivated → back');

\echo '--- 3. staff cannot grant themselves an event'
select tt.as_user('00000000-0000-0000-0000-0000000f5e02');
select tt.check(tt.err($$insert into event_assignments (event_id, assignee_role, assignee_id, title) values ('00000000-0000-0000-0000-0000000f5ea2', 'staff', auth.uid(), 'Self')$$) like '%row-level security%',
  'staff cannot insert an assignment for themselves');
select tt.check(tt.err($$update event_assignments set event_id = '00000000-0000-0000-0000-0000000f5ea2' where id = '00000000-0000-0000-0000-0000000f5a01'$$) like '%Only staff/admin can change assignment details%',
  'staff cannot move their assignment to another event');
select tt.check(tt.err($$update event_assignments set assignee_role = 'staff', event_id = '00000000-0000-0000-0000-0000000f5ea2' where id = '00000000-0000-0000-0000-0000000f5a03'$$) is not null
  or not exists (select 1 from event_assignments where id = '00000000-0000-0000-0000-0000000f5a03' and event_id = '00000000-0000-0000-0000-0000000f5ea2'),
  'nor take over someone else''s');
update event_assignments set status = 'confirmed' where id = '00000000-0000-0000-0000-0000000f5a01';
select tt.as_owner();
select tt.check((select status::text = 'confirmed' and event_id = '00000000-0000-0000-0000-0000000f5ea1' from event_assignments where id = '00000000-0000-0000-0000-0000000f5a01'), 'confirming their own assignment still works (and nothing else changed)');
select tt.as_user('00000000-0000-0000-0000-0000000f5e05');
select tt.check(tt.err($$update event_assignments set assignee_role = 'staff' where id = '00000000-0000-0000-0000-0000000f5a03'$$) similar to '%(Only staff/admin can change assignment details|Only staff/admin accounts can be assigned as event staff)%',
  'a volunteer cannot turn their slot into a staff assignment');
select tt.as_owner();
select tt.check(tt.err($$insert into event_assignments (event_id, assignee_role, assignee_id, title, assigned_by) values ('00000000-0000-0000-0000-0000000f5ea2', 'staff', '00000000-0000-0000-0000-0000000f5e06', 'X', '00000000-0000-0000-0000-0000000f5e01')$$)
  like '%Only staff/admin accounts can be assigned as event staff%', 'a patron cannot be made event staff');

\echo '--- 4. consistent with what staff can see'
select tt.as_user('00000000-0000-0000-0000-0000000f5e02');
select tt.check(not exists (select 1 from bookings where id in ('00000000-0000-0000-0000-0000000f5b01', '00000000-0000-0000-0000-0000000f5b02')),
  'staff read no bookings directly (bookings.view_all is admin-only) — the console never offers them Resend');
select tt.check(can_view_event_attendees('00000000-0000-0000-0000-0000000f5ea1') and not can_view_event_attendees('00000000-0000-0000-0000-0000000f5ea2'),
  'attendee access follows the same assignment (A yes, B no)');
select tt.as_owner();

\echo ''
\echo 'ALL STAFF RESEND SCOPE DATABASE TESTS PASSED'
rollback;
