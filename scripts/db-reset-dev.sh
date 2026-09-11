#!/usr/bin/env bash
# OneBook ELD — reset the DEV database only (tz.md §22.3.7).
# drop -> migrate -> seed.
#
# Hard refuses to run if:
#   1) NODE_ENV=production, or
#   2) DATABASE_URL points at the prod database (onebook_eld) —
#      checked independently of NODE_ENV, matching the two-way guard
#      described in tz.md §22.3.4 (core/config/db-guard.ts).
#
# Usage: bash scripts/db-reset-dev.sh
# Requires: DATABASE_URL set to the dev DSN (onebook_eld_dev / eld_dev).

set -euo pipefail

if [[ "${NODE_ENV:-}" == "production" ]]; then
  echo "db-reset-dev: refusing to run — NODE_ENV=production." >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "db-reset-dev: DATABASE_URL is not set." >&2
  exit 2
fi

# Extract the database name (path component) from the DSN without
# depending on NODE_ENV alone — this is the second, independent leg of
# the two-way guard from tz.md §22.3.4.
DB_NAME="$(node -e "console.log(new URL(process.env.DATABASE_URL).pathname.replace(/^\//, ''))" 2>/dev/null || true)"

if [[ -z "$DB_NAME" ]]; then
  echo "db-reset-dev: could not parse DATABASE_URL to determine the database name." >&2
  exit 2
fi

if [[ "$DB_NAME" == "onebook_eld" ]]; then
  echo "db-reset-dev: refusing to run — DATABASE_URL points at the PROD database (onebook_eld)." >&2
  exit 1
fi

if [[ "$DB_NAME" != "onebook_eld_dev" ]]; then
  echo "db-reset-dev: refusing to run — DATABASE_URL points at unknown database \"$DB_NAME\" (expected onebook_eld_dev)." >&2
  exit 1
fi

echo "db-reset-dev: resetting $DB_NAME ..."

# `prisma migrate reset` does drop -> migrate -> seed (runs prisma/seed.ts
# per the "seed" config in package.json) in one step, and is itself
# guarded by requiring explicit confirmation unless --force is passed.
npx prisma migrate reset --force --skip-generate

echo "db-reset-dev: done."
