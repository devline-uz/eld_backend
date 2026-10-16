-- DOWN migration for 20261014160000_session_rotated_to
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- Access tokens issued on a rotated-away session stop resolving to its successor.
ALTER TABLE "Session" DROP COLUMN IF EXISTS "rotatedToId";
