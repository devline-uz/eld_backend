#!/usr/bin/env bash
# OneBook ELD — prove every migration applies (up) AND reverts (down).
# tasks.md Global gate: "Every migration tested `up` and `down` on the **dev DB**".
#
# For each directory in prisma/migrations, in filename order:
#   1) snapshot the schema            (S_before)
#   2) apply migration.sql            (up)
#   3) snapshot the schema            (S_after_up)
#   4) apply down.sql                 (down)
#   5) snapshot and require it equals S_before  -> proves the down is complete
#   6) re-apply migration.sql and require the snapshot equals S_after_up
#      -> proves up is replayable after a revert
# A migration directory with no down.sql fails the run.
#
# WHERE IT RUNS. On the dev Postgres server only (the one DATABASE_URL points at),
# inside a scratch database it creates and drops itself — `onebook_eld_updown`, owned by
# the same role that owns onebook_eld_dev so ownership/privilege semantics (the §5.5
# append-only REVOKE) match the real dev database. The dev database itself is never
# touched: some down files intentionally re-grant UPDATE/DELETE on the append-only ledger
# or drop columns, which must never happen to a database anyone is using.
#
# Usage:  npm run migrate:test-updown        (loads .env.development)
#         DATABASE_URL=... bash scripts/migrate-updown-dev.sh
#
# Requires: psql + pg_dump (16) on PATH, and a superuser DSN to create the scratch DB —
# SUPERUSER_DATABASE_URL, or POSTGRES_SUPERUSER / POSTGRES_SUPERUSER_PASSWORD (read from
# backend/.env when not already exported).

set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$BACKEND_DIR/prisma/migrations"
# Unique per run: two concurrent runs (two agents / a CI matrix) must not drop each
# other's scratch database mid-migration — DROP DATABASE ... WITH (FORCE) would terminate
# the other run's connection ("terminating connection due to administrator command").
SCRATCH_DB="onebook_eld_updown_$$_${RANDOM}"
WORK_DIR="$(mktemp -d)"
FAILURES=0

log()  { echo "migrate-updown: $*"; }
fail() { echo "migrate-updown: FAIL — $*" >&2; FAILURES=$((FAILURES + 1)); }

# ---------------------------------------------------------------------------
# Guards (same two-way shape as scripts/db-reset-dev.sh, tz.md §22.3.4)
# ---------------------------------------------------------------------------
if [[ "${NODE_ENV:-}" == "production" ]]; then
  echo "migrate-updown: refusing to run — NODE_ENV=production." >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  # Fall back to .env.development so the npm script needs no extra wiring.
  if [[ -f "$BACKEND_DIR/.env.development" ]]; then
    DATABASE_URL="$(grep -E '^DATABASE_URL=' "$BACKEND_DIR/.env.development" | head -1 | cut -d= -f2-)"
  fi
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "migrate-updown: DATABASE_URL is not set (and .env.development has none)." >&2
  exit 2
fi

read -r DB_HOST DB_PORT DB_USER DB_PASS DB_NAME <<<"$(DATABASE_URL="$DATABASE_URL" node -e '
const u = new URL(process.env.DATABASE_URL);
process.stdout.write([u.hostname, u.port || 5432, decodeURIComponent(u.username),
  decodeURIComponent(u.password), u.pathname.replace(/^\//, "")].join(" "));
')"

if [[ "$DB_NAME" == "onebook_eld" ]]; then
  echo "migrate-updown: refusing to run — DATABASE_URL points at the PROD database (onebook_eld)." >&2
  exit 1
fi
if [[ "$DB_NAME" != "onebook_eld_dev" ]]; then
  echo "migrate-updown: refusing to run — expected the dev database (onebook_eld_dev), got \"$DB_NAME\"." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Superuser connection (scratch DB create/drop only)
# ---------------------------------------------------------------------------
SU_USER="${POSTGRES_SUPERUSER:-postgres}"
SU_PASS="${POSTGRES_SUPERUSER_PASSWORD:-}"
if [[ -z "$SU_PASS" && -f "$BACKEND_DIR/.env" ]]; then
  SU_PASS="$(grep -E '^POSTGRES_SUPERUSER_PASSWORD=' "$BACKEND_DIR/.env" | head -1 | cut -d= -f2-)"
fi
if [[ -z "$SU_PASS" ]]; then
  echo "migrate-updown: need POSTGRES_SUPERUSER_PASSWORD (or SUPERUSER_DATABASE_URL) to create the scratch database." >&2
  exit 2
fi

su_psql() { PGPASSWORD="$SU_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$SU_USER" -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
db_psql() { PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$SCRATCH_DB" -v ON_ERROR_STOP=1 -q "$@"; }

cleanup() {
  su_psql -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE);" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

log "dev server $DB_HOST:$DB_PORT — using scratch database \"$SCRATCH_DB\" (owner $DB_USER)"
su_psql -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE);" >/dev/null
su_psql -c "CREATE DATABASE \"$SCRATCH_DB\" OWNER \"$DB_USER\";" >/dev/null

# ---------------------------------------------------------------------------
# Snapshot = structure (pg_dump, owner/ACL noise stripped) + the semantic
# privilege matrix that carries the append-only invariant.
#
# --no-acl is deliberate: a REVOKE on a default (NULL) ACL materialises the ACL, and a
# materialised ACL can never be turned back into NULL, so textual ACL comparison would
# report a permanent false difference. `has_table_privilege` compares what actually
# matters — whether the app role can UPDATE/DELETE the ledger — and that IS restored by
# the down file.
# ---------------------------------------------------------------------------
PRIV_QUERY="
SELECT c.relname, r.rolname,
       has_table_privilege(r.oid, c.oid, 'UPDATE') AS upd,
       has_table_privilege(r.oid, c.oid, 'DELETE') AS del
  FROM pg_class c
  CROSS JOIN pg_roles r
 WHERE c.relnamespace = 'public'::regnamespace
   AND c.relkind IN ('r', 'p')
   AND r.rolname IN ('eld_dev', 'eld_prod')
 ORDER BY 1, 2;"

snapshot() {
  local out="$1"
  PGPASSWORD="$DB_PASS" pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$SCRATCH_DB" \
    --schema-only --no-owner --no-acl --no-comments \
    | { grep -vE '^(--|SET |SELECT pg_catalog\.set_config|\\(un)?restrict |$)' || true; } >"$out"
  echo '-- effective UPDATE/DELETE privileges (append-only invariant) --' >>"$out"
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$SCRATCH_DB" \
    -At -F '|' -c "$PRIV_QUERY" >>"$out"
}

apply_sql() { # apply_sql <file> <label>
  if ! db_psql -f "$1" >"$WORK_DIR/apply.log" 2>&1; then
    echo "----- psql output ($2) -----" >&2
    cat "$WORK_DIR/apply.log" >&2
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Per-migration up / down / re-up
# ---------------------------------------------------------------------------
i=0
for dir in $(find "$MIGRATIONS_DIR" -mindepth 1 -maxdepth 1 -type d | sort); do
  name="$(basename "$dir")"
  i=$((i + 1))
  before="$WORK_DIR/${i}_before"
  after_up="$WORK_DIR/${i}_after_up"
  after_down="$WORK_DIR/${i}_after_down"
  after_reup="$WORK_DIR/${i}_after_reup"

  snapshot "$before"

  log "[$name] up"
  if ! apply_sql "$dir/migration.sql" "$name up"; then
    fail "[$name] migration.sql did not apply — cannot continue past it."
    break
  fi
  snapshot "$after_up"

  if [[ ! -f "$dir/down.sql" ]]; then
    fail "[$name] no down.sql — every migration needs a tested reverse path."
    continue
  fi

  log "[$name] down"
  if ! apply_sql "$dir/down.sql" "$name down"; then
    fail "[$name] down.sql did not apply."
    continue
  fi
  snapshot "$after_down"

  if diff -u "$before" "$after_down" >"$WORK_DIR/diff_down"; then
    log "[$name] down verified — schema matches the pre-migration state"
  else
    fail "[$name] down.sql did not restore the pre-migration schema:"
    sed -n '1,60p' "$WORK_DIR/diff_down" >&2
  fi

  log "[$name] up again (replay after revert)"
  if ! apply_sql "$dir/migration.sql" "$name re-up"; then
    fail "[$name] migration.sql failed to replay after its down."
    break
  fi
  snapshot "$after_reup"
  if ! diff -u "$after_up" "$after_reup" >"$WORK_DIR/diff_reup"; then
    fail "[$name] replaying migration.sql produced a different schema than the first apply:"
    sed -n '1,60p' "$WORK_DIR/diff_reup" >&2
    continue
  fi
  log "[$name] OK (up · down · up)"
done

if [[ "$FAILURES" -gt 0 ]]; then
  echo "migrate-updown: $FAILURES migration(s) failed the up/down check." >&2
  exit 1
fi

log "all $i migration(s) passed up · down · up on the dev server."
exit 0
