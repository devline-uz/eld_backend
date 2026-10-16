-- DOWN migration for 20261014210000_user_lockout_role_name_unique
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- Drops the case-insensitive role-name index and the lockout columns (any current lockout is
-- lifted). The UP's trimming of role names is not undone.
-- custom-index: drop Role_name_lower_key
DROP INDEX IF EXISTS "Role_name_lower_key";
ALTER TABLE "User" DROP COLUMN IF EXISTS "lockedUntil";
ALTER TABLE "User" DROP COLUMN IF EXISTS "failedLoginCount";
