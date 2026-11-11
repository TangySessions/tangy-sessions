-- READ-ONLY preflight for 0039_no_zero_price_ticket_types.sql. Every
-- statement is a SELECT; nothing changes. Nothing here blocks 0039 — it
-- changes no rows — but anything listed in 2 is a ticket type customers see
-- on sale and cannot buy: give it a price or take it off sale.

-- 1. Baseline. Expect: has_0038 = true, has_0039 = false.
select
  to_regprocedure('public.event_booking_closed(date,text,text,timestamptz)') is not null as has_0038,
  to_regprocedure('public.enforce_ticket_type_price()') is not null                        as has_0039;

-- 2. Ticket types ON SALE at ₹0 (unbuyable today). Expect no rows.
select e.name as event, e.event_date, e.status as event_status, t.code, t.name, t.price
from event_ticket_types t join events e on e.id = t.event_id
where t.price < 1 and t.active
order by e.event_date, t.sort_order;

-- 3. Ticket types at ₹0 already off sale (harmless; listed for completeness).
select e.name as event, e.event_date, t.code, t.name, t.price
from event_ticket_types t join events e on e.id = t.event_id
where t.price < 1 and not t.active
order by e.event_date, t.sort_order;

-- 4. Events with no price (events.price < 1). After 0039 a NEW event created
--    without a price gets no automatic ticket type; existing ones are unaffected.
select count(*) as events_without_price from events where coalesce(price, 0) < 1;
