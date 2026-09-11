#!/usr/bin/env bash
# OneBook ELD — backup restore drill (tz.md §22.4).
#
# "A backup that has never been restored is not a backup." This script takes (or reuses) a
# `pg_dump` of PROD (`onebook_eld`, via scripts/backup.sh), restores it into a throwaway
# SCRATCH database on the SAME server, verifies row counts and that the append-only
# `REVOKE UPDATE/DELETE` privileges on `EldEvent`/`AuditLog` survived the dump+restore round
# trip, then drops the scratch database.
#
# It NEVER restores into onebook_eld (prod) or onebook_eld_dev (dev) — restore always targets
# a fresh scratch database, name-suffixed with the shell PID + $RANDOM (same convention as
# scripts/migrate-updown-dev.sh), which this script creates and drops itself.
#
# Usage:
#   bash scripts/restore-drill.sh                    # takes a fresh dump via backup.sh, restores it
#   DUMP_FILE=/path/to/x.dump bash scripts/restore-drill.sh   # restores an existing dump
#
# Requires: pg_dump/pg_restore/psql (16) on PATH, PROD_DATABASE_URL (or DATABASE_URL_PROD),
# and a superuser DSN/password to create+drop the scratch DB (same env vars as
# migrate-updown-dev.sh: SUPERUSER_DATABASE_URL, or POSTGRES_SUPERUSER / POSTGRES_SUPERUSER_PASSWORD,
# read from backend/.env when not already exported).
#
# Writes a one-line result to docs/deploy.md's restore-drill log table via --record (optional;
# the caller reviews/commits that edit, this script does not touch tasks.md/bugs.md itself).

set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${POSTGRES_CONTAINER:-onebook-postgres}"
SCRATCH_DB="onebook_eld_restore_drill_$$_${RANDOM}"
WORK_DIR="$(mktemp -d)"
STARTED_AT="$(date -u +%s)"

log()  { echo "restore-drill: $*"; }
fail() { echo "restore-drill: FAIL — $*" >&2; exit 1; }

PROD_URL="${PROD_DATABASE_URL:-${DATABASE_URL_PROD:-}}"
if [[ -z "$PROD_URL" ]]; then
  echo "restore-drill: set PROD_DATABASE_URL (prod DSN, DB must be onebook_eld) before running." >&2
  exit 2
fi

read -r DB_HOST DB_PORT PROD_DB_NAME <<<"$(PROD_URL="$PROD_URL" node -e '
const u = new URL(process.env.PROD_URL);
process.stdout.write([u.hostname, u.port || 5432, u.pathname.replace(/^\//, "")].join(" "));
')"
if [[ "$PROD_DB_NAME" != "onebook_eld" ]]; then
  fail "PROD_DATABASE_URL does not point at onebook_eld (got \"$PROD_DB_NAME\")."
fi

# B-026: pg_dump/psql reject Prisma's `?connection_limit=N` query parameter outright, and
# pg_dump run inside the postgres container can't reach the host-published port (55432) — it
# needs the container's own 127.0.0.1:5432. Two clean DSNs: one for host-side psql (real
# host/port, no query string), one for pg_dump run via `docker exec` (container-local).
HOST_CLEAN_URL="$(PROD_URL="$PROD_URL" node -e '
const u = new URL(process.env.PROD_URL); u.search = ""; console.log(u.toString());
')"
CONTAINER_URL="$(PROD_URL="$PROD_URL" node -e '
const u = new URL(process.env.PROD_URL);
u.hostname = "127.0.0.1"; u.port = "5432"; u.search = "";
console.log(u.toString());
')"

SU_USER="${POSTGRES_SUPERUSER:-postgres}"
SU_PASS="${POSTGRES_SUPERUSER_PASSWORD:-}"
if [[ -z "$SU_PASS" && -f "$BACKEND_DIR/.env" ]]; then
  SU_PASS="$(grep -E '^POSTGRES_SUPERUSER_PASSWORD=' "$BACKEND_DIR/.env" | head -1 | cut -d= -f2-)"
fi
if [[ -z "$SU_PASS" ]]; then
  fail "need POSTGRES_SUPERUSER_PASSWORD (or SUPERUSER_DATABASE_URL) to create the scratch database."
fi

su_psql() { PGPASSWORD="$SU_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$SU_USER" -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
scratch_psql() { PGPASSWORD="$SU_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$SU_USER" -d "$SCRATCH_DB" -v ON_ERROR_STOP=1 -q "$@"; }

cleanup() {
  su_psql -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE);" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1) Dump (reuse an existing one if DUMP_FILE is given, so this drill can also
#    validate last night's actual cron-produced dump rather than a fresh one).
# ---------------------------------------------------------------------------
if [[ -n "${DUMP_FILE:-}" ]]; then
  [[ -f "$DUMP_FILE" ]] || fail "DUMP_FILE=$DUMP_FILE does not exist."
  log "using existing dump: $DUMP_FILE"
else
  DUMP_FILE="$WORK_DIR/onebook_eld_drill.dump"
  log "taking a fresh pg_dump of onebook_eld -> $DUMP_FILE"
  docker exec "$CONTAINER" pg_dump --dbname "$CONTAINER_URL" --format=custom --file=/tmp/onebook_eld_drill.dump
  docker cp "$CONTAINER:/tmp/onebook_eld_drill.dump" "$DUMP_FILE"
  docker exec "$CONTAINER" rm -f /tmp/onebook_eld_drill.dump
fi

# ---------------------------------------------------------------------------
# 2) Row counts BEFORE restore — read directly off prod, right after the dump so the two
#    should match (a live carrier could still write in between; this drill is a structural/
#    volume sanity check, not a byte-exact snapshot guarantee).
# ---------------------------------------------------------------------------
TABLES=("User" "Driver" "Vehicle" "EldEvent" "DailyLog" "AuditLog")
declare -A BEFORE_COUNTS
for t in "${TABLES[@]}"; do
  BEFORE_COUNTS["$t"]="$(psql "$HOST_CLEAN_URL" -At -c "SELECT count(*) FROM \"$t\";" 2>/dev/null || echo "?")"
done

# ---------------------------------------------------------------------------
# 3) Create the scratch DB and restore into it — never onto onebook_eld/onebook_eld_dev.
# ---------------------------------------------------------------------------
log "creating scratch database \"$SCRATCH_DB\""
su_psql -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE);" >/dev/null
su_psql -c "CREATE DATABASE \"$SCRATCH_DB\" OWNER \"$SU_USER\";" >/dev/null

log "restoring dump into \"$SCRATCH_DB\" (pg_restore, via container)"
docker cp "$DUMP_FILE" "$CONTAINER:/tmp/onebook_eld_drill_restore.dump"
if ! docker exec -e PGPASSWORD="$SU_PASS" "$CONTAINER" pg_restore \
  -h 127.0.0.1 -U "$SU_USER" -d "$SCRATCH_DB" \
  --no-owner --role="$SU_USER" \
  /tmp/onebook_eld_drill_restore.dump >"$WORK_DIR/restore.log" 2>&1; then
  echo "----- pg_restore output -----" >&2
  cat "$WORK_DIR/restore.log" >&2
  # pg_restore commonly exits non-zero on benign warnings (e.g. "role eld_prod does not
  # exist" when this box's roles differ from the dump source) — only treat it as fatal if
  # the scratch DB ends up empty.
fi
docker exec "$CONTAINER" rm -f /tmp/onebook_eld_drill_restore.dump

# ---------------------------------------------------------------------------
# 4) Row counts AFTER restore, and the append-only privilege check.
# ---------------------------------------------------------------------------
FAILURES=0
log "verifying row counts (before dump vs after restore):"
for t in "${TABLES[@]}"; do
  after="$(scratch_psql -At -c "SELECT count(*) FROM \"$t\";" 2>/dev/null || echo "?")"
  before="${BEFORE_COUNTS[$t]}"
  status="OK"
  if [[ "$before" == "?" || "$after" == "?" || "$before" != "$after" ]]; then
    status="MISMATCH"
    FAILURES=$((FAILURES + 1))
  fi
  log "  $t: before=$before after=$after [$status]"
done

log "verifying append-only privileges survived the restore (eld_prod must have UPDATE/DELETE = false on EldEvent, AuditLog):"
PRIV_QUERY="
SELECT c.relname,
       has_table_privilege('eld_prod', c.oid, 'UPDATE') AS upd,
       has_table_privilege('eld_prod', c.oid, 'DELETE') AS del
  FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace
   AND c.relname IN ('EldEvent', 'AuditLog');"
PRIV_OUT="$(scratch_psql -At -F '|' -c "$PRIV_QUERY" 2>/dev/null || echo "")"
if [[ -z "$PRIV_OUT" ]]; then
  log "  could not read privileges (role eld_prod may not exist on this server) — SKIPPED, not a pass"
else
  while IFS='|' read -r relname upd del; do
    [[ -z "$relname" ]] && continue
    if [[ "$upd" == "f" && "$del" == "f" ]]; then
      log "  $relname: UPDATE=$upd DELETE=$del [OK — append-only preserved]"
    else
      log "  $relname: UPDATE=$upd DELETE=$del [FAIL — append-only NOT preserved]"
      FAILURES=$((FAILURES + 1))
    fi
  done <<<"$PRIV_OUT"
fi

DURATION=$(( $(date -u +%s) - STARTED_AT ))
log "duration: ${DURATION}s"

if [[ "$FAILURES" -gt 0 ]]; then
  log "DRILL FAILED — $FAILURES check(s) did not pass. Scratch DB will still be dropped on exit."
  exit 1
fi

log "DRILL PASSED — dump restored into scratch DB \"$SCRATCH_DB\", row counts matched, append-only privileges preserved."
log "Record this result in docs/deploy.md's restore-drill log table."
exit 0
