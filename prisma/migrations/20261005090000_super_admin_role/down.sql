-- DOWN migration for 20261005090000_super_admin_role
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- The UP is data-only (one idempotent INSERT of the SUPER_ADMIN system role), so the reverse is a
-- guarded DELETE: the row is removed only while NO user references it ("User"."roleId" is a
-- RESTRICT FK, and silently re-pointing administrators to another role would change who may
-- manage ADMIN users). If a user is still assigned SUPER_ADMIN the statement deletes nothing —
-- re-assign those users first, then run this again.
DELETE FROM "Role" r
WHERE r."key" = 'SUPER_ADMIN'
  AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."roleId" = r."id");
