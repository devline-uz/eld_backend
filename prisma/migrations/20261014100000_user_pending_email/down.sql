-- DOWN migration for 20261014100000_user_pending_email
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- Any pending web-user email change (and its hold / revert data) is lost.
DROP INDEX IF EXISTS "User_pendingEmail_idx";
ALTER TABLE "User" DROP COLUMN IF EXISTS "emailChangedAt",
DROP COLUMN IF EXISTS "pendingEmail",
DROP COLUMN IF EXISTS "pendingEmailRequestedAt",
DROP COLUMN IF EXISTS "pendingEmailRequestedById",
DROP COLUMN IF EXISTS "previousEmail";
