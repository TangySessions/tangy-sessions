-- READ-ONLY preflight for 0037_one_pending_hold_per_account.sql. Every
-- statement is a SELECT; nothing changes.

-- 1. Baseline. Expect: has_0036 = true, has_0037 = false.
select
  exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'artist-documents: own upload'
          and with_check like '%foldername(objects.name)%')                       as has_0036,
  to_regclass('public.bookings_one_active_hold') is not null                     as has_0037;

-- 2. BLOCKING: accounts with more than one ACTIVE (not yet stale) pending hold
--    for the same session. 0037 expires stale holds first; anything listed
--    here would stop it. Expect no rows.
select user_id, event_id, count(*) as active_holds, array_agg(registration_code order by created_at) as codes
from bookings
where status = 'pending' and user_id is not null
  and (razorpay_payment_id is not null
       or created_at >= now() - make_interval(mins => setting_number('bookings.pending_timeout_minutes', 30)::int))
group by user_id, event_id having count(*) > 1;

-- 3. Stale unpaid holds 0037 will expire first (the same sweep the job runs).
select count(*) as stale_unpaid_holds from bookings
where status = 'pending' and razorpay_payment_id is null and coalesce(source, 'checkout') <> 'complimentary'
  and created_at < now() - make_interval(mins => setting_number('bookings.pending_timeout_minutes', 30)::int);
