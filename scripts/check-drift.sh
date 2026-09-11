#!/usr/bin/env bash
# OneBook ELD — nightly schema drift check (tz.md §22.3.5).
#
# Compares the dev and prod database schemas via `prisma migrate diff`.
# Exits non-zero and prints a message if they differ, so the cron wrapper
# (or CI) can turn that into an email alert.
#
# Usage: bash scripts/check-drift.sh
# Requires: DEV_DATABASE_URL and PROD_DATABASE_URL in the environment
# (or DATABASE_URL_DEV / DATABASE_URL_PROD — see fallback below).
#
# Optional: TEXTFILE_COLLECTOR_DIR — when set, also writes
# onebook_schema_drift_detected{} (0/1) as a node_exporter textfile-collector metric, which
# docker/prometheus/alerts.yml's SchemaDrift rule reads. Unset by default: this script is
# CI/cron plumbing, not a running exporter, so the metric emission is opt-in and never fails
# the run on its own.

set -euo pipefail

DEV_URL="${DEV_DATABASE_URL:-${DATABASE_URL_DEV:-}}"
PROD_URL="${PROD_DATABASE_URL:-${DATABASE_URL_PROD:-}}"

emit_metric() { # emit_metric <0|1>
  [[ -n "${TEXTFILE_COLLECTOR_DIR:-}" ]] || return 0
  mkdir -p "$TEXTFILE_COLLECTOR_DIR" 2>/dev/null || return 0
  {
    echo "# HELP onebook_schema_drift_detected 1 if the last db:check-drift run found dev/prod schema drift"
    echo "# TYPE onebook_schema_drift_detected gauge"
    echo "onebook_schema_drift_detected $1"
  } >"$TEXTFILE_COLLECTOR_DIR/onebook_schema_drift.prom.tmp" 2>/dev/null &&
    mv "$TEXTFILE_COLLECTOR_DIR/onebook_schema_drift.prom.tmp" "$TEXTFILE_COLLECTOR_DIR/onebook_schema_drift.prom" 2>/dev/null || true
}

if [[ -z "$DEV_URL" || -z "$PROD_URL" ]]; then
  echo "check-drift: set DEV_DATABASE_URL and PROD_DATABASE_URL (dev/prod DSNs) before running." >&2
  exit 2
fi

echo "check-drift: comparing dev schema (onebook_eld_dev) against prod schema (onebook_eld)..."

DIFF_OUTPUT="$(npx prisma migrate diff \
  --from-url "$DEV_URL" \
  --to-url "$PROD_URL" \
  --script 2>&1)" || {
  echo "check-drift: prisma migrate diff failed to run:" >&2
  echo "$DIFF_OUTPUT" >&2
  exit 2
}

# `prisma migrate diff --script` prints only a header comment (no SQL
# statements) when the two schemas are identical. Any actual SQL
# statement in the output means the schemas have drifted.
if echo "$DIFF_OUTPUT" | grep -qE '^(CREATE|ALTER|DROP)'; then
  echo "check-drift: SCHEMA DRIFT DETECTED between dev and prod." >&2
  echo "$DIFF_OUTPUT" >&2
  emit_metric 1
  exit 1
fi

echo "check-drift: no drift — dev and prod schemas match."
emit_metric 0
exit 0
