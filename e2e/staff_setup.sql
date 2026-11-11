-- LOCAL TEST DATA ONLY: make Vol. 5 "today" for the staff flow and reset its check-ins.
update events set event_date = (now() at time zone 'Asia/Kolkata')::date where name = 'Tangy Sessions Vol. 5';
-- Vol. 6 is "next month" (seed.sql: current_date + 21). Re-date it on every run
-- so a long-lived local database never leaves it in the past, where it would
-- drop off "upcoming" and refuse bookings (0038).
update events set event_date = (now() at time zone 'Asia/Kolkata')::date + 21 where slug = 'vol-6-local';
alter table event_tasks disable trigger guard_event_task_status_trigger;
update event_tasks set due_at = ((now() at time zone 'Asia/Kolkata')::date + time '20:00') at time zone 'Asia/Kolkata', status = 'pending';
alter table event_tasks enable trigger guard_event_task_status_trigger;
delete from checkins where ticket_id in (select id from tickets);
update tickets set status = 'valid' where status = 'checked_in';
