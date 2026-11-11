-- READ-ONLY preflight for 0040_artist_self_edit_guard.sql. Every statement is
-- a SELECT; nothing changes. Nothing here blocks 0040 (it changes no rows).
-- Before 0040 an artist could edit the review fields on their own row; these
-- queries list rows whose review record looks inconsistent, for a person to
-- check. Expect no rows.

-- 1. Baseline. Expect: has_0039 = true, has_0040 = false.
select
  to_regprocedure('public.enforce_ticket_type_price()') is not null as has_0039,
  to_regprocedure('public.guard_artist_self_edit()') is not null    as has_0040;

-- 2. Review data on applications that were never decided.
select id, name, status, reviewed_by, reviewed_at, decision_reason is not null as has_reason
from artists
where status = 'pending' and (reviewed_by is not null or reviewed_at is not null or decision_reason is not null);

-- 3. Decided applications whose reviewer is the artist themself, or not a console role.
select a.id, a.name, a.status, a.reviewed_by, p.role as reviewer_role
from artists a left join profiles p on p.id = a.reviewed_by
where a.status in ('approved', 'rejected') and a.reviewed_by is not null
  and (a.reviewed_by = a.user_id or p.role is null or p.role not in ('admin', 'super_admin', 'staff'));

-- 4. Timeline that cannot be right: reviewed before applying, or applied in the future.
select id, name, applied_at, reviewed_at
from artists
where (reviewed_at is not null and reviewed_at < applied_at) or applied_at > now() + interval '5 minutes';

-- 5. Internal notes written by the artist themself (moved into application_reviews by 0033).
select r.source_id as artist_id, a.name, r.updated_at
from application_reviews r join artists a on a.id = r.source_id
where r.source_table = 'artists' and r.updated_by is not null and r.updated_by = a.user_id;
