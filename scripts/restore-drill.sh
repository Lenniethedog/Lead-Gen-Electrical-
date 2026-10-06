#!/usr/bin/env bash
# Restore drill: prove a backup restores into a scratch database and contains what production had.
# Run monthly, and after any change to the backup job. It NEVER touches the source database.
#
#   usage: scripts/restore-drill.sh <dump file | dump.age file | s3://bucket/prefix/leadgen-<stamp>.dump[.age]>
#
#   RESTORE_ADMIN_URL    postgres:// URL (no query string) of a server where a scratch database may be created and dropped,
#                        ending in /postgres, e.g. postgres://postgres@127.0.0.1:54349/postgres. NEVER production.
#   AGE_IDENTITY_FILE    private key file, required for .age dumps
#   SOURCE_DATABASE_URL  optional: if set, row counts are compared with the live source (use right after a backup)
#   R2_ENDPOINT_URL      for s3:// sources (aws CLI + credentials)
#
# After a REAL restore (not a drill) you must also: run db/roles.sql if the server is new, re-apply the
# erasure/suppression log (docs/04: backups still hold data erased since), and run `npm run db:migrate`.
# STATUS: rehearsed for local dump files; the age and s3:// paths are written to the tools' interfaces but not run.
set -euo pipefail
umask 077

src="${1:?usage: restore-drill.sh <dump file | s3://...>}"
: "${RESTORE_ADMIN_URL:?set RESTORE_ADMIN_URL}"
case "$RESTORE_ADMIN_URL" in
  *\?*) echo "error: RESTORE_ADMIN_URL must not contain a query string" >&2; exit 1 ;;
  */postgres) ;;
  *) echo "error: RESTORE_ADMIN_URL must end in /postgres" >&2; exit 1 ;;
esac

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' not found on PATH" >&2; exit 1; }; }
need psql; need pg_restore

work="$(mktemp -d)"
scratch="leadgen_drill_$(date -u +%Y%m%d%H%M%S)_$$"
scratch_url="${RESTORE_ADMIN_URL%/postgres}/$scratch"
cleanup() {
  psql "$RESTORE_ADMIN_URL" -qAt -c "drop database if exists \"$scratch\" with (force)" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

started=$(date +%s)

# 1. Fetch
case "$src" in
  s3://*) need aws; : "${R2_ENDPOINT_URL:?set R2_ENDPOINT_URL}"; aws s3 cp --endpoint-url "$R2_ENDPOINT_URL" --only-show-errors "$src" "$work/"; file="$work/$(basename "$src")" ;;
  *) [ -f "$src" ] || { echo "error: no such file: $src" >&2; exit 1; }; file="$src" ;;
esac

# 2. Decrypt
case "$file" in
  *.age) need age; : "${AGE_IDENTITY_FILE:?set AGE_IDENTITY_FILE to decrypt .age dumps}"; age -d -i "$AGE_IDENTITY_FILE" -o "$work/restore.dump" "$file"; file="$work/restore.dump" ;;
esac

# 3. Restore into a scratch database. pg_restore exits non-zero on ANY error: a drill with errors has failed.
psql "$RESTORE_ADMIN_URL" -qAt -c "create database \"$scratch\"" >/dev/null
restore_started=$(date +%s)
pg_restore --no-owner --exit-on-error --dbname "$scratch_url" "$file"
restore_seconds=$(( $(date +%s) - restore_started ))

q() { psql "$1" -qAt -c "$2"; }

# 4. Sanity: the data is there and the schema is at the version the dump claims.
fail=0
check() { # label, restored value, expected description (value must be non-empty / > 0 when no source)
  printf '  %-34s %s\n' "$1" "$2"
}
echo "restore drill: $(basename "$src") -> $scratch"
for table in leads lead_contacts consent_records consent_texts lead_events lead_status_history operator_alerts operators \
  clients client_services client_service_areas pricing_rules lead_assignments lead_assignment_status_history suppressions audit_logs; do
  restored="$(q "$scratch_url" "select count(*) from $table")"
  if [ -n "${SOURCE_DATABASE_URL:-}" ]; then
    live="$(q "$SOURCE_DATABASE_URL" "select count(*) from $table")"
    if [ "$restored" != "$live" ]; then
      check "$table" "$restored (MISMATCH: source has $live)"; fail=1
    else
      check "$table" "$restored (matches source)"
    fi
  else
    check "$table" "$restored"
  fi
done
migrations="$(q "$scratch_url" "select count(*) from pgmigrations")"
latest="$(q "$scratch_url" "select name from pgmigrations order by id desc limit 1")"
check "migrations applied" "$migrations (latest: $latest)"
[ "$migrations" -ge 1 ] || fail=1
# Integrity that a restore can silently break: every lead has contact details and consent (deferred constraint, so check it here).
orphans="$(q "$scratch_url" "select count(*) from leads l where not exists (select 1 from consent_records c where c.lead_id = l.id and c.event = 'granted') or not exists (select 1 from lead_contacts c where c.lead_id = l.id)")"
check "leads without consent/contact" "$orphans (must be 0)"
# Stage 3: the deferred constraint "an assigned lead has an active assignment" and the double-sale guard, checked on what was restored.
unheld="$(q "$scratch_url" "select count(*) from leads l where l.status = 'assigned' and not exists (select 1 from lead_assignments a where a.lead_id = l.id and a.status in ('reserved','notified','accepted','disputed'))")"
check "assigned leads with no holder" "$unheld (must be 0)"
doubled="$(q "$scratch_url" "select count(*) from (select lead_id from lead_assignments where sale_type = 'exclusive' and status in ('reserved','notified','accepted','disputed') group by lead_id having count(*) > 1) d")"
check "exclusive leads held twice" "$doubled (must be 0)"
[ "$orphans" = "0" ] || fail=1
[ "$unheld" = "0" ] || fail=1
[ "$doubled" = "0" ] || fail=1

total_seconds=$(( $(date +%s) - started ))
echo "  restore_seconds=$restore_seconds total_seconds=$total_seconds"
if [ "$fail" = "0" ]; then
  echo "DRILL PASSED"
else
  echo "DRILL FAILED" >&2
  exit 1
fi
