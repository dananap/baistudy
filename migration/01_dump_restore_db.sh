#!/usr/bin/env bash
# Phase 1: dump source Postgres and restore into Supabase.
#
# Usage:
#   SOURCE_URL='postgres://...current-prod...' \
#   TARGET_URL='postgres://postgres:<password>@db.<ref>.supabase.co:5432/postgres' \
#   bash migration/01_dump_restore_db.sh
#
# Notes:
#   - Use the DIRECT Supabase URL (port 5432), not the pooled one (6543).
#     The pooler doesn't support all the statements pg_restore emits.
#   - --no-owner --no-acl strip GCP-specific roles. --clean --if-exists makes
#     the restore idempotent so we can re-run during dry-runs.
#   - This restores `public.*` only — Supabase's own `auth`, `storage`,
#     `extensions` schemas are untouched.

set -euo pipefail

: "${SOURCE_URL:?SOURCE_URL is required}"
: "${TARGET_URL:?TARGET_URL is required}"

DUMP_FILE="${DUMP_FILE:-./baistudy.dump}"

echo "==> Dumping from source..."
pg_dump \
  --format=custom \
  --no-owner --no-acl \
  --schema=public \
  --file="$DUMP_FILE" \
  "$SOURCE_URL"

echo "==> Restoring into Supabase..."
pg_restore \
  --no-owner --no-acl \
  --clean --if-exists \
  --schema=public \
  --dbname="$TARGET_URL" \
  "$DUMP_FILE"

echo "==> Smoke check on target..."
psql "$TARGET_URL" -c "SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM words) AS words, (SELECT count(*) FROM cards) AS cards, (SELECT count(*) FROM review_logs) AS reviews;"

echo "Done. Verify counts match source, then update DATABASE_URL on the backend."
