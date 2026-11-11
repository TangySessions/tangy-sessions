#!/usr/bin/env bash
# Validates supabase/production-bootstrap/ on a THROWAWAY local PostgreSQL 16
# cluster (same Supabase shim as scripts/test-db-local.sh). Never connects to
# a Supabase project.
#
#   1. checks the package: 0004 absent, unchanged copies byte-identical to
#      supabase/migrations/, the two .production.sql files differ from their
#      originals by deletions only
#   2. applies every package file in order, each as its own transaction
#   3. runs the read-only production inventory and the empty-database checks
#   4. runs every supabase/tests/*.test.sql suite on the same database — no
#      seed or mock content is ever inserted; suites create their own test
#      rows inside their own transaction and roll them back
set -uo pipefail
cd "$(dirname "$0")/.."
B=supabase/production-bootstrap
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${PORT:-54331}"
WORK="$(mktemp -d)"; chmod 777 "$WORK"
as_pg() { if [ "$(id -u)" = "0" ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
cleanup() { as_pg "$PG_BIN/pg_ctl -D '$WORK/data' -m immediate stop" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
fail=0
pass() { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; fail=1; }

echo "== 1. package"
ls $B/0004_* >/dev/null 2>&1 && bad "0004 is in the package" || pass "0004 is not in the package"
n=0; for f in $B/0*.sql; do
  b=$(basename "$f")
  case "$b" in
    *.production.sql)
      o=supabase/migrations/${b%.production.sql}.sql
      if diff "$o" "$f" | grep -q '^>'; then bad "$b adds lines to $o"; else pass "$b = $(basename "$o") minus $(diff "$o" "$f" | grep -c '^<') deleted lines, nothing added"; fi ;;
    *) cmp -s "$f" "supabase/migrations/$b" && n=$((n + 1)) || bad "$b differs from supabase/migrations/$b" ;;
  esac
done
pass "$n unchanged copies are byte-identical to supabase/migrations/"
[ "$(ls $B/0*.sql | wc -l)" = "44" ] && pass "44 migration files (0001-0045 without 0004)" || bad "expected 44 files"

echo "== 2. apply to a fresh local database"
as_pg "$PG_BIN/initdb -D '$WORK/data' -U postgres --auth=trust" >/dev/null || exit 1
as_pg "$PG_BIN/pg_ctl -D '$WORK/data' -o \"-p $PORT -k '$WORK' -c listen_addresses=''\" -l '$WORK/pg.log' -w start" >/dev/null || exit 1
P() { psql -h "$WORK" -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
P -f supabase/tests/local/supabase_shim.sql >/dev/null 2>&1 || { echo "shim failed"; exit 1; }
applied=0
for f in $B/0*.sql; do
  out=$(P -1 -f "$f" 2>&1) || { bad "$(basename "$f") failed: $(echo "$out" | grep -m1 ERROR)"; exit 1; }
  applied=$((applied + 1))
done
pass "applied $applied files in order (0001-0003, 0005-0045)"

echo "== 3. production inventory (read-only) and empty-database checks"
P -A -F ' | ' -t -c "begin transaction read only" -f $B/checks/production_inventory.readonly.sql -c "rollback" | sed 's/^/   /'
q() { P -At -c "$1"; }
chk() { [ "$(q "$1")" = "$2" ] && pass "$3" || bad "$3 (got: $(q "$1"))"; }
chk "select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in ('announcements','tv_videos','gallery_albums','gallery_photos','diary_posts','programmes','venues','role_permissions','system_settings')" 9 "CMS / RBAC / settings tables exist"
chk "select string_agg(id, ',' order by id) from storage.buckets" "artist-avatars,artist-documents,artist-media,content-media,event-documents,sponsor-assets" "all 6 storage buckets exist"
chk "select count(*) from events" 0 "no seed events (0004 skipped)"
chk "select count(*) from announcements" 0 "no mock announcements"
chk "select (select count(*) from tv_videos) + (select count(*) from gallery_albums) + (select count(*) from gallery_photos) + (select count(*) from diary_posts)" 0 "no seeded TV / gallery / diary content"
chk "select (select count(*) from auth.users) + (select count(*) from profiles)" 0 "no users or profiles"
chk "select (select count(*) from bookings) + (select count(*) from tickets) + (select count(*) from checkins) + (select count(*) from payment_webhook_events)" 0 "no bookings, tickets, check-ins or payment events"
chk "select (select count(*) from artists) + (select count(*) from collaborations) + (select count(*) from crew_applications) + (select count(*) from private_enquiries) + (select count(*) from contact_enquiries) + (select count(*) from artist_applications)" 0 "no artists, applications or enquiries"
chk "select (select count(*) from conversations) + (select count(*) from messages) + (select count(*) from notifications)" 0 "no conversations, messages or notifications"
chk "select (select count(*) from venues) + (select count(*) from event_ticket_types) + (select count(*) from waitlist)" 0 "no derived venues, ticket types or waitlist rows"
chk "select count(*) > 0 from role_permissions" t "role permissions configured"
chk "select count(*) > 0 from system_settings" t "system settings configured"
chk "select bool_and(c.relrowsecurity) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('announcements','tv_videos','gallery_albums','gallery_photos','diary_posts','programmes','programme_events')" t "RLS enabled on announcements and every CMS table"
chk "select count(distinct tablename) from pg_policies where schemaname = 'public' and tablename in ('announcements','tv_videos','gallery_albums','gallery_photos','diary_posts','programmes','programme_events')" 7 "every CMS table has RLS policies"
chk "select count(*) from pg_policies where tablename = 'announcements' and policyname in ('announcements: public read live','announcements: staff read relevant','announcements: content managers')" 3 "announcement policies: public live read, staff relevant read, content managers"
chk "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'announcements' and column_name in ('title','body','category','character','destination','audience','priority','publish_at','expire_at','status','author_id','event_id')" 12 "announcements columns as the CMS uses them"
chk "select count(*) from role_permissions where role = 'super_admin' and permission in ('content.view','content.create','content.edit','content.publish','content.delete','content.manage','announcements.view')" 7 "super_admin holds every content permission"
chk "select count(*) from role_permissions where role = 'staff' and permission like 'content.%'" 0 "staff get no content permissions by default"
chk "select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('content_can','content_guard_publish','content_slugify','content_media_is_public','update_session_content','portal_announcements')" 6 "CMS functions exist"
chk "select string_agg(tgrelid::regclass::text, ',' order by tgrelid::regclass::text) from pg_trigger where not tgisinternal and tgfoid = 'content_guard_publish'::regproc" "diary_posts,gallery_albums,programmes,tv_videos" "publish guard on every content table with a status (photos follow their album)"
chk "select public = false and file_size_limit = 52428800 and not ('text/html' = any (allowed_mime_types)) from storage.buckets where id = 'content-media'" t "content-media bucket: private, 50 MB, no HTML"
chk "select count(*) > 0 from pg_policies where schemaname = 'storage' and tablename = 'objects' and (qual like '%content-media%' or with_check like '%content-media%')" t "content-media storage policies exist"
chk "select has_function_privilege('anon', 'content_can(text,text)', 'execute') and not has_function_privilege('anon', 'update_session_content(uuid,jsonb)', 'execute')" t "visitors can run the content read helper, not the session-copy editor"
chk "select exists (select 1 from pg_proc where proname = 'artist_day_status' and pronamespace = 'public'::regnamespace)" t "0034 detected"
chk "select exists (select 1 from pg_proc where proname = 'guard_application_start' and pronamespace = 'public'::regnamespace)" t "0035 detected"
chk "select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'artist-documents: own %' and coalesce(qual, with_check) like '%foldername(objects.name)%'" 3 "0036 detected: artist-documents own policies read the folder from storage.objects.name"
chk "select to_regclass('public.bookings_one_active_hold') is not null and exists (select 1 from pg_proc where proname = 'create_pending_booking' and prosrc like '%tangy.booking_hold%')" t "0037 detected: one active hold per account (index + serialized create_pending_booking)"
chk "select to_regprocedure('event_booking_closed(date,text,text,timestamptz)') is not null and exists (select 1 from pg_proc where proname = 'create_pending_booking' and prosrc like '%EVENT_CLOSED%')" t "0038 detected: no booking after the session's local date"
chk "select exists (select 1 from pg_trigger where tgname = 'event_ticket_types_price_min' and tgrelid = 'public.event_ticket_types'::regclass)" t "0039 detected: no ₹0 ticket types (minimum-price trigger)"
chk "select exists (select 1 from pg_trigger where tgname = 'artists_guard_self_edit' and tgrelid = 'public.artists'::regclass)" t "0040 detected: artists cannot edit review / identity fields of their own row"
chk "select to_regprocedure('public.has_open_artist_application()') is not null and exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'sponsor-assets: delete' and qual like '%sponsor_assets%')" t "0041 detected: storage follows the review lifecycle"
chk "select pg_get_viewdef('public.public_artists'::regclass) like '%COALESCE(NULLIF(btrim(stage_name)%'" t "0042 detected: public_artists shows the public name"
chk "select to_regprocedure('public.set_programme_sessions(uuid,uuid[])') is not null" t "0043 detected: atomic programme sessions"
chk "select exists (select 1 from pg_proc where proname = 'join_waitlist' and prosrc like '%event_booking_closed%')" t "0044 detected: waitlist uses the event-local date"
chk "select has_table_privilege('anon', 'public.public_artists', 'SELECT') and has_table_privilege('authenticated', 'public.public_artists', 'SELECT') and not has_any_column_privilege('anon', 'public.public_artists', 'UPDATE') and not has_table_privilege('anon', 'public.public_artists', 'DELETE') and not has_any_column_privilege('authenticated', 'public.public_artists', 'UPDATE') and not has_table_privilege('authenticated', 'public.public_artists', 'DELETE')" t "0045 detected: public_artists is read-only for anon / authenticated (SELECT kept)"

echo "== 4. test suites (no seed or mock content inserted)"
total=0; failed=""
for f in supabase/tests/*.test.sql; do
  out=$(P < "$f" 2>&1)
  c=$(echo "$out" | grep -c "NOTICE:  ok"); total=$((total + c))
  if echo "$out" | grep -qE "^(psql:[^ ]* )?ERROR"; then
    failed="$failed $(basename "$f" .test.sql)"; echo "   $(basename "$f"): FAILED after $c — $(echo "$out" | grep -m1 ERROR | cut -c1-110)"
  else
    echo "   $(basename "$f"): $c"
  fi
done
suites=$(ls supabase/tests/*.test.sql | wc -l | tr -d ' ')
echo "   $suites suites, $total assertions"
[ -z "$failed" ] && pass "all $suites suites pass on the production schema ($total assertions)" || bad "failing suites:$failed"
chk "select (select count(*) from events) + (select count(*) from announcements) + (select count(*) from tv_videos) + (select count(*) from gallery_albums) + (select count(*) from gallery_photos) + (select count(*) from diary_posts) + (select count(*) from auth.users) + (select count(*) from profiles) + (select count(*) from artists) + (select count(*) from bookings) + (select count(*) from tickets) + (select count(*) from checkins) + (select count(*) from payment_webhook_events) + (select count(*) from collaborations) + (select count(*) from crew_applications) + (select count(*) from artist_applications) + (select count(*) from private_enquiries) + (select count(*) from contact_enquiries) + (select count(*) from conversations) + (select count(*) from messages) + (select count(*) from notifications)" 0 "after the suites the database is still empty (every suite rolled back)"
exit $fail
