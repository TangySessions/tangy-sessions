#!/usr/bin/env bash
# Concurrent checkouts against create_pending_booking (0037) on a THROWAWAY
# local PostgreSQL 16 cluster (same shim as scripts/test-db-local.sh; never
# touches a Supabase project). Each request runs in its own connection and
# keeps its transaction open briefly, so the requests really overlap.
#
#   A. one account, 8 simultaneous checkouts for one session (all different
#      details) → exactly one active hold, no error but RATE_LIMITED
#   B. one account, 8 simultaneous identical checkouts → exactly one active hold
#   C. 8 different accounts racing for 5 seats → exactly 5 holds, 3 SOLD_OUT,
#      capacity never exceeded
#
#   BASELINE=1 scripts/test-pending-holds-concurrency.sh   # same, without 0037
#   (shows the original problem: one account ends up with several holds)
set -uo pipefail
cd "$(dirname "$0")/.."
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${PORT:-54332}"
UP_TO=9999; [ "${BASELINE:-}" = "1" ] && UP_TO=0036
WORK="$(mktemp -d)"; chmod 777 "$WORK"
as_pg() { if [ "$(id -u)" = "0" ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
cleanup() { as_pg "$PG_BIN/pg_ctl -D '$WORK/data' -m immediate stop" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
as_pg "$PG_BIN/initdb -D '$WORK/data' -U postgres --auth=trust" >/dev/null || exit 1
as_pg "$PG_BIN/pg_ctl -D '$WORK/data' -o \"-p $PORT -k '$WORK' -c listen_addresses='' -c max_connections=50\" -l '$WORK/pg.log' -w start" >/dev/null || exit 1
P() { psql -h "$WORK" -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
P -f supabase/tests/local/supabase_shim.sql >/dev/null 2>&1 || { echo "shim failed"; exit 1; }
n=0
for f in supabase/migrations/*.sql; do
  [ "$(basename "$f" | cut -c1-4)" \> "$UP_TO" ] && break
  P -1 -f "$f" >/dev/null 2>&1 || { echo "FAILED $(basename "$f")"; exit 1; }
  n=$((n + 1))
done
echo "applied $n migrations$([ "$UP_TO" = 0036 ] && echo ' (BASELINE: without 0037)')"
fail=0
pass() { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; fail=1; }

E=00000000-0000-0000-0000-0000000cc0e1
P -c "insert into auth.users (id, email, aud, role) select ('00000000-0000-0000-0000-0000000cc0' || lpad(g::text, 2, '0'))::uuid, 'test-c' || g || '@holds.tangy.test', 'authenticated', 'authenticated' from generate_series(1, 20) g;
      insert into events (id, slug, name, event_date, capacity, price, status, booking_min_quantity, booking_max_quantity)
        values ('$E', 'test-race', 'Test Race Night', current_date + 20, 40, 500, 'on-sale', 1, 4);
      update event_ticket_types set price = 500, active = true, capacity = null where event_id = '$E' and code = 'gen';" >/dev/null

# hold <user-suffix> <code> <qty> <phone>: one checkout in its own connection,
# transaction kept open 1 s after the call so the next requests queue behind it.
hold() {
  P -At -c "begin; select (create_pending_booking('00000000-0000-0000-0000-0000000cc0$1', '$E', '$2', 'Racer', 'r@holds.tangy.test', '$4', $3, null, 'gen', null,
    (select array_agg('Guest ' || g) from generate_series(1, $3) g), '{\"answers\":{}}'::jsonb)).id; select pg_sleep(1); commit;" 2>&1 | grep -oE "ERROR: +[A-Z_]+|[0-9a-f-]{36}" | head -1
}
race() { local out="$WORK/race.$1"; : > "$out"; shift; for spec in "$@"; do ( hold $spec >> "$out" ) & done; wait; }
active() { P -At -c "select count(*) from bookings where event_id = '$E' and status = 'pending' and user_id = '00000000-0000-0000-0000-0000000cc0$1'"; }

echo "== A. one account, 8 simultaneous checkouts with different details"
race A "01 TEST-RA1 1 9876543201" "01 TEST-RA2 2 9876543202" "01 TEST-RA3 1 9876543203" "01 TEST-RA4 2 9876543204" \
       "01 TEST-RA5 1 9876543205" "01 TEST-RA6 2 9876543206" "01 TEST-RA7 1 9876543207" "01 TEST-RA8 2 9876543208"
[ "$(active 01)" = "1" ] && pass "exactly one active hold for the account" || bad "account holds $(active 01) active holds at once"
others=$(grep -vE "^[0-9a-f-]{36}$|RATE_LIMITED" "$WORK/race.A" | sort | uniq -c | tr '\n' ' ')
[ -z "$others" ] && pass "every request either got the hold or was RATE_LIMITED ($(grep -c RATE_LIMITED "$WORK/race.A") throttled) — no deadlock, no unique-index error" || bad "unexpected outcomes: $others"

echo "== B. one account, 8 simultaneous identical checkouts"
race B "02 TEST-RB1 2 9876543210" "02 TEST-RB2 2 9876543210" "02 TEST-RB3 2 9876543210" "02 TEST-RB4 2 9876543210" \
       "02 TEST-RB5 2 9876543210" "02 TEST-RB6 2 9876543210" "02 TEST-RB7 2 9876543210" "02 TEST-RB8 2 9876543210"
[ "$(active 02)" = "1" ] && pass "exactly one active hold for the account" || bad "account holds $(active 02) active holds at once"

echo "== C. 8 accounts racing for the last 5 seats"
P -c "update events set capacity = (select coalesce(sum(quantity), 0) from bookings where event_id = '$E' and status in ('pending', 'confirmed')) + 5 where id = '$E'" >/dev/null
race C "03 TEST-RC3 1 9876543213" "04 TEST-RC4 1 9876543214" "05 TEST-RC5 1 9876543215" "06 TEST-RC6 1 9876543216" \
       "07 TEST-RC7 1 9876543217" "08 TEST-RC8 1 9876543218" "09 TEST-RC9 1 9876543219" "10 TEST-RC10 1 9876543220"
held=$(P -At -c "select coalesce(sum(quantity), 0) from bookings where event_id = '$E' and status in ('pending', 'confirmed')")
cap=$(P -At -c "select capacity from events where id = '$E'")
[ "$held" -le "$cap" ] && pass "capacity never exceeded ($held of $cap held)" || bad "overbooked: $held of $cap"
[ "$(grep -cE '^[0-9a-f-]{36}$' "$WORK/race.C")" = "5" ] && [ "$(grep -c SOLD_OUT "$WORK/race.C")" = "3" ] \
  && pass "5 accounts got a hold, 3 were told SOLD_OUT" || bad "outcomes: $(sort "$WORK/race.C" | sed 's/[0-9a-f-]\{36\}/hold/' | uniq -c | tr '\n' ' ')"

exit $fail
