#!/usr/bin/env bash
# Logical backup of the leadgen database: dump -> verify the archive is readable -> checksum ->
# encrypt -> copy to the destination. Run nightly (see docs/runbook.md); restore with
# scripts/restore-drill.sh at least monthly. An untested backup is not a backup.
#
#   BACKUP_DATABASE_URL     postgres:// URL of a role that can read everything (the owner or a dedicated backup role)
#   BACKUP_DEST             a directory, or s3://bucket/prefix on S3-compatible storage (Cloudflare R2).
#                           S3 needs the aws CLI, R2_ENDPOINT_URL and AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
#   AGE_RECIPIENT           an `age` PUBLIC key; the dump is encrypted to it. REQUIRED: the dump contains
#                           consumers' personal data. Rehearsals on a laptop may set BACKUP_ALLOW_UNENCRYPTED=1.
#
# The password in the URL is visible in the process list while pg_dump runs: run this only where you
# are the sole user (a container), never on a shared machine.
#
# STATUS: the dump/verify/restore path is rehearsed (docs/06-operations.md). The `age` and S3 paths were
# written to the tools' documented interfaces but NOT run (neither tool was available): run one real
# backup and one real drill into R2 before relying on them.
set -euo pipefail
umask 077

: "${BACKUP_DATABASE_URL:?set BACKUP_DATABASE_URL}"
: "${BACKUP_DEST:?set BACKUP_DEST (a directory or s3://bucket/prefix)}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' not found on PATH" >&2; exit 1; }; }
need pg_dump; need pg_restore; need shasum

encrypt=1
if [ -z "${AGE_RECIPIENT:-}" ]; then
  if [ "${BACKUP_ALLOW_UNENCRYPTED:-}" = "1" ]; then
    encrypt=0
    echo "warning: writing an UNENCRYPTED dump of personal data (BACKUP_ALLOW_UNENCRYPTED=1). Rehearsals only." >&2
  else
    echo "error: AGE_RECIPIENT is not set. The dump contains personal data and must be encrypted." >&2
    exit 1
  fi
else
  need age
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT   # the dump holds personal data: never leave it behind, even on failure
file="$work/leadgen-$stamp.dump"

started=$(date +%s)
# Custom format: compressed, and pg_restore can restore selectively. Ownership is dropped so it restores
# under any role; privileges are KEPT (the app role's grants), so create the role first on a fresh server (db/roles.sql).
pg_dump --format=custom --compress=6 --no-owner --lock-wait-timeout=30s --dbname "$BACKUP_DATABASE_URL" --file "$file"

# A dump that cannot be read back is worse than none: prove the archive parses and contains the data we care about.
pg_restore --list "$file" > "$work/toc.txt"
for table in leads lead_contacts consent_records operator_alerts; do
  grep -q "TABLE DATA public $table " "$work/toc.txt" || { echo "error: dump has no data section for $table" >&2; exit 1; }
done

sha="$(shasum -a 256 "$file" | cut -d' ' -f1)"
size="$(wc -c < "$file" | tr -d ' ')"
artefact="$file"
if [ "$encrypt" = "1" ]; then
  age -r "$AGE_RECIPIENT" -o "$file.age" "$file"
  rm -f "$file"
  artefact="$file.age"
fi
printf '%s  %s\n' "$sha" "$(basename "$file")" > "$work/leadgen-$stamp.sha256"   # checksum of the PLAINTEXT dump

case "$BACKUP_DEST" in
  s3://*)
    need aws
    : "${R2_ENDPOINT_URL:?set R2_ENDPOINT_URL for S3-compatible storage}"
    aws s3 cp --endpoint-url "$R2_ENDPOINT_URL" --only-show-errors "$artefact" "${BACKUP_DEST%/}/"
    aws s3 cp --endpoint-url "$R2_ENDPOINT_URL" --only-show-errors "$work/leadgen-$stamp.sha256" "${BACKUP_DEST%/}/"
    ;;
  *)
    mkdir -p "$BACKUP_DEST"
    cp "$artefact" "$work/leadgen-$stamp.sha256" "$BACKUP_DEST/"
    ;;
esac

echo "backup ok: $(basename "$artefact") plaintext_sha256=$sha plaintext_bytes=$size encrypted=$encrypt seconds=$(( $(date +%s) - started )) dest=$BACKUP_DEST"
