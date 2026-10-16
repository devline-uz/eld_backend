-- DOWN migration for 20261013120000_driver_pending_email
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- Any pending driver email change (and its hold / revert data) is lost.
DROP INDEX IF EXISTS "Driver_pendingEmail_idx";
ALTER TABLE "Driver" DROP COLUMN IF EXISTS "pendingEmail",
DROP COLUMN IF EXISTS "pendingEmailRequestedAt",
DROP COLUMN IF EXISTS "pendingEmailRequestedById",
DROP COLUMN IF EXISTS "emailChangedAt",
DROP COLUMN IF EXISTS "previousEmail";
