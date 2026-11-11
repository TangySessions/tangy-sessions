-- READ-ONLY production inventory for TangySessions. ONE SELECT statement:
-- it reads system catalogs and counts rows; it cannot write, create, alter
-- or drop anything. Paste the whole thing into the SQL editor and run it.
-- It does not error on an empty database. No personal data is returned
-- (auth users are counted, never listed).
with
mig(n, label, applied) as (values
  ('0001', 'schema',                          to_regclass('public.bookings') is not null and to_regtype('public.user_role') is not null),
  ('0002', 'rls',                             to_regprocedure('public.is_staff_or_admin()') is not null),
  ('0003', 'role_security',                   to_regprocedure('public.prevent_role_self_escalation()') is not null),
  ('0004', 'seed_events (data, not schema)',  null),
  ('0005', 'extend_roles',                    exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'user_role' and e.enumlabel = 'vendor')),
  ('0006', 'role_profiles',                   to_regclass('public.vendor_profiles') is not null),
  ('0007', 'payments',                        to_regclass('public.payment_webhook_events') is not null),
  ('0008', 'conversations_and_assignments',   to_regclass('public.conversations') is not null),
  ('0009', 'waitlist_self_read',              exists (select 1 from pg_policies where policyname = 'waitlist: self read own by email') or to_regprocedure('public.guard_application_start()') is not null),
  ('0010', 'venue_role',                      exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'user_role' and e.enumlabel = 'venue')),
  ('0011', 'role_portals',                    to_regclass('public.venue_profiles') is not null),
  ('0012', 'artist_availability',             to_regclass('public.artist_availability') is not null),
  ('0013', 'artist_media',                    to_regclass('public.artist_media') is not null),
  ('0014', 'artist_spotify',                  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'artists' and column_name = 'spotify')),
  ('0015', 'application_lifecycle',           to_regclass('public.application_notifications') is not null),
  ('0016', 'payments_tickets_checkin',        to_regclass('public.tickets') is not null),
  ('0017', 'admin_system',                    to_regclass('public.role_permissions') is not null),
  ('0018', 'operations_platform',             exists (select 1 from pg_proc where proname = 'portal_path' and pronamespace = 'public'::regnamespace)),
  ('0019', 'platform_enum_values',            exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'booking_status' and e.enumlabel = 'expired')),
  ('0020', 'platform_finalization',           to_regclass('public.artist_private_profiles') is not null),
  ('0021', 'canonical_admin_links',           exists (select 1 from pg_proc where proname = 'canonical_console_link' and pronamespace = 'public'::regnamespace)),
  ('0022', 'artist_storage_policies (no unique object)', null),
  ('0023', 'named_group_checkin',             exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bookings' and column_name = 'attendee_names')),
  ('0024', 'event_booking_form',              exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'events' and column_name = 'booking_min_quantity')),
  ('0025', 'enquiries_auth_first',            exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'contact_enquiries' and column_name = 'user_id')),
  ('0026', 'ticket_types_and_settlement',     to_regclass('public.event_ticket_types') is not null),
  ('0027', 'waitlist',                        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'waitlist' and column_name = 'quantity')),
  ('0028', 'content_cms',                     exists (select 1 from pg_proc where proname = 'content_can' and pronamespace = 'public'::regnamespace)),
  ('0029', 'private_media_realtime_jobs',     to_regclass('public.event_availability_signal') is not null),
  ('0030', 'invitations_and_volunteer_access', to_regclass('public.account_invitations') is not null),
  ('0031', 'programmes_and_history',          to_regclass('public.programmes') is not null),
  ('0032', 'booking_request_states',          exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'assignment_status' and e.enumlabel = 'completed')),
  ('0033', 'artist_portal',                   to_regclass('public.application_reviews') is not null),
  ('0034', 'event_artist_workflow',           exists (select 1 from pg_proc where proname = 'artist_day_status' and pronamespace = 'public'::regnamespace)),
  ('0035', 'phase1_security_gaps',            exists (select 1 from pg_proc where proname = 'guard_application_start' and pronamespace = 'public'::regnamespace)),
  ('0036', 'fix_artist_documents_storage',    exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'artist-documents: own upload' and with_check like '%foldername(objects.name)%')),
  ('0037', 'one_pending_hold_per_account',    to_regclass('public.bookings_one_active_hold') is not null),
  ('0038', 'no_booking_after_event_date',     to_regprocedure('public.event_booking_closed(date,text,text,timestamptz)') is not null),
  ('0039', 'no_zero_price_ticket_types',      to_regprocedure('public.enforce_ticket_type_price()') is not null),
  ('0040', 'artist_self_edit_guard',          to_regprocedure('public.guard_artist_self_edit()') is not null),
  ('0041', 'storage_lifecycle_guards',        to_regprocedure('public.has_open_artist_application()') is not null),
  ('0042', 'public_artist_display_name',      coalesce(pg_get_viewdef(to_regclass('public.public_artists')) like '%COALESCE(NULLIF(btrim(stage_name)%', false)),
  ('0043', 'atomic_programme_sessions',       to_regprocedure('public.set_programme_sessions(uuid,uuid[])') is not null),
  ('0044', 'waitlist_event_local_date',       exists (select 1 from pg_proc where proname = 'join_waitlist' and prosrc like '%event_booking_closed%')),
  ('0045', 'public_artists_read_only',        coalesce((select not has_any_column_privilege('anon', c.oid, 'UPDATE') and not has_table_privilege('anon', c.oid, 'DELETE')
                                                         and not has_any_column_privilege('authenticated', c.oid, 'UPDATE') and not has_table_privilege('authenticated', c.oid, 'DELETE')
                                                       from pg_class c where c.oid = to_regclass('public.public_artists')), false))
),
user_schemas as (
  select nspname from pg_namespace
  where nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
    and nspname not like 'pg_temp_%' and nspname not like 'pg_toast_temp_%'
)
select * from (
  select 1 as ord, 'PROJECT' as section, 'database / server' as item,
         current_database() || ' / PostgreSQL ' || current_setting('server_version') as value
  union all
  select 2, 'SCHEMAS', 'all non-system schemas', string_agg(nspname, ', ' order by nspname) from user_schemas
  union all
  select 3, 'TABLES', 'tables per schema', string_agg(s || '=' || n, ', ' order by s) from (
    select n.nspname s, count(*) n from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname in (select nspname from user_schemas) group by 1) x
  union all
  select 4, 'TABLES', 'public tables', coalesce((select count(*)::text || ': ' || string_agg(relname, ', ' order by relname)
    from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')), '0')
  union all
  select 5, 'VIEWS', 'public views', coalesce((select count(*)::text || ': ' || string_agg(relname, ', ' order by relname)
    from pg_class where relnamespace = 'public'::regnamespace and relkind in ('v', 'm')), '0')
  union all
  select 6, 'FUNCTIONS', 'public functions (all / security definer)',
    (select count(*) || ' / ' || count(*) filter (where prosecdef) from pg_proc where pronamespace = 'public'::regnamespace)
  union all
  select 7, 'TRIGGERS', 'user triggers on public tables / on auth.users',
    (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relnamespace = 'public'::regnamespace)
    || ' / ' ||
    (select count(*) from pg_trigger where not tgisinternal and tgrelid = to_regclass('auth.users'))
  union all
  select 8, 'TYPES', 'public enum types', coalesce((select string_agg(typname, ', ' order by typname) from pg_type
    where typnamespace = 'public'::regnamespace and typtype = 'e'), 'none')
  union all
  select 9, 'AUTH', 'auth.users (count only)',
    case when to_regclass('auth.users') is null then 'auth.users missing' else
      (xpath('/row/c/text()', query_to_xml('select count(*) as c from auth.users', false, true, '')))[1]::text end
  union all
  select 10, 'STORAGE', 'buckets (id:public)',
    case when to_regclass('storage.buckets') is null then 'storage.buckets missing' else
      coalesce((xpath('/row/c/text()', query_to_xml('select string_agg(id || '':'' || public, '', '' order by id) as c from storage.buckets', false, true, '')))[1]::text, '0 buckets') end
  union all
  select 11, 'STORAGE', 'storage.objects (count only)',
    case when to_regclass('storage.objects') is null then 'storage.objects missing' else
      (xpath('/row/c/text()', query_to_xml('select count(*) as c from storage.objects', false, true, '')))[1]::text end
  union all
  select 12, 'MIGRATION HISTORY', 'supabase_migrations.schema_migrations',
    case when to_regclass('supabase_migrations.schema_migrations') is null then 'NOT PRESENT (migrations were never applied with the Supabase CLI)' else
      coalesce((xpath('/row/c/text()', query_to_xml('select count(*) || '' rows: '' || string_agg(version, '', '' order by version) as c from supabase_migrations.schema_migrations', false, true, '')))[1]::text, 'present, 0 rows') end
  union all
  select 13, 'MIGRATION MARKERS', 'applied (detected by objects)',
    coalesce((select string_agg(n, ', ' order by n) from mig where applied), 'none')
  union all
  select 14, 'MIGRATION MARKERS', 'NOT applied (detected by objects)',
    coalesce((select string_agg(n, ', ' order by n) from mig where applied = false), 'none')
  union all
  select 15, 'MIGRATION MARKERS', 'latest detected',
    coalesce((select n || ' ' || label from mig where applied order by n desc limit 1), 'none')
  union all
  select 16, 'DATA', 'row counts in key public tables',
    coalesce((select string_agg(t || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text, ', ' order by t)
      from unnest(array['profiles', 'events', 'artists', 'bookings', 'tickets', 'checkins', 'waitlist', 'collaborations', 'crew_applications']) t
      where to_regclass('public.' || t) is not null), 'no application tables')
  union all
  select 17, '0035 PREFLIGHT', 'artists with duplicate user_id (blocking for 0035)',
    case when to_regclass('public.artists') is null then 'n/a (no artists table)' else
      (xpath('/row/c/text()', query_to_xml('select count(*) as c from (select user_id from public.artists where user_id is not null group by user_id having count(*) > 1) d', false, true, '')))[1]::text end
) report
order by ord;
