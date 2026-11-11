#!/usr/bin/env bash
# LOCAL STACK ONLY. Writes the EXPECTED schema fingerprint of the repository
# (supabase/ops/schema_fingerprint.readonly.sql run against a fresh database
# built from the migrations) as CSV, for comparison with production:
#
#   scripts/test-fresh-db.sh                       # builds tangy_fresh from supabase/migrations
#   scripts/schema-fingerprint.sh > expected.csv   # this script (read-only on tangy_fresh)
#   # production: run supabase/ops/schema_fingerprint.readonly.sql in the SQL
#   # editor, "Download CSV" → production.csv
#   node scripts/compare-schema-fingerprint.mjs expected.csv production.csv
#
# The fingerprint query is a single SELECT on system catalogs; it is executed
# here in a read-only transaction. It never connects to production.
set -euo pipefail
C="${DB_CONTAINER:-$(docker ps --format '{{.Names}}' | grep -m1 '^supabase_db_')}"
DB="${FINGERPRINT_DB:-tangy_fresh}"
cd "$(dirname "$0")/.."
{
  echo 'begin transaction read only;'
  cat supabase/ops/schema_fingerprint.readonly.sql
  echo 'rollback;'
} | docker exec -i "$C" psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 --csv
