#!/usr/bin/env bash
# OneBook ELD — nightly prod backup (tz.md §22.4).
#
# Dumps the PROD database ONLY (never dev). Intended to run from cron on
# the host, targeting the postgres container.
#
# This script covers the pg_dump leg. The other two legs of §22.4 are
# NOT scriptable here and must be set up separately:
#   - WAL archiving + PITR (7 days): configure `archive_mode = on` and
#     `archive_command` in postgresql.conf, pointed at the same
#     off-server destination as BACKUP_DEST below. This gives point-in-
#     time recovery on top of the nightly full dumps.
#   - Off-server copy: BACKUP_DEST below should already be a mount/path
#     on a DIFFERENT physical server (e.g. rsync target, S3 bucket
#     outside this box). Do not treat a local path as done — it must be
#     shipped off-box before this script is considered complete.
#   - Monthly restore drill: run this dump against a scratch database on
#     a separate instance once a month and record the result (date,
#     duration, success/failure) in backend/docs/deploy.md's restore log.
#
# Usage: bash scripts/backup.sh
# Requires: PROD_DATABASE_URL (or DATABASE_URL_PROD), BACKUP_DEST.

set -euo pipefail

PROD_URL="${PROD_DATABASE_URL:-${DATABASE_URL_PROD:-}}"
BACKUP_DEST="${BACKUP_DEST:-/var/backups/onebook-eld}"
CONTAINER="${POSTGRES_CONTAINER:-onebook-postgres}"

if [[ -z "$PROD_URL" ]]; then
  echo "backup: set PROD_DATABASE_URL (prod DSN, DB must be onebook_eld) before running." >&2
  exit 2
fi

DB_NAME="$(node -e "console.log(new URL(process.env.PROD_URL).pathname.replace(/^\//, ''))" PROD_URL="$PROD_URL" 2>/dev/null || true)"
if [[ "$DB_NAME" != "onebook_eld" ]]; then
  echo "backup: refusing to run — PROD_DATABASE_URL does not point at onebook_eld (got \"$DB_NAME\")." >&2
  exit 1
fi

mkdir -p "$BACKUP_DEST"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="$BACKUP_DEST/onebook_eld_${TIMESTAMP}.dump"

echo "backup: dumping onebook_eld -> $DUMP_FILE"

docker exec -e PGPASSWORD_UNUSED=1 "$CONTAINER" pg_dump \
  --dbname "$PROD_URL" \
  --format=custom \
  --file=/tmp/onebook_eld_backup.dump

docker cp "$CONTAINER:/tmp/onebook_eld_backup.dump" "$DUMP_FILE"
docker exec "$CONTAINER" rm -f /tmp/onebook_eld_backup.dump

echo "backup: local dump complete ($DUMP_FILE)."
echo "backup: REMINDER — ship this file to the off-server backup destination"
echo "        (this script does not do that transfer itself; wire it to"
echo "        rsync/rclone/S3 sync per the target server's setup)."
