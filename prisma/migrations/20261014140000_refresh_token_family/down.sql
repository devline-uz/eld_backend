-- DOWN migration for 20261014140000_refresh_token_family
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- Refresh-token family / rotation data is lost (reuse detection falls back to the old rule).
DROP INDEX IF EXISTS "Session_familyId_idx";
DROP INDEX IF EXISTS "DriverSession_familyId_idx";
ALTER TABLE "Session" DROP COLUMN IF EXISTS "familyId", DROP COLUMN IF EXISTS "rotatedAt";
ALTER TABLE "DriverSession" DROP COLUMN IF EXISTS "familyId", DROP COLUMN IF EXISTS "rotatedAt";
