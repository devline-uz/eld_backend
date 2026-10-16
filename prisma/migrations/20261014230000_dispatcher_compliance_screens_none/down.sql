-- DOWN migration for 20261014230000_dispatcher_compliance_screens_none
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- The UP is data-only: the system DISPATCHER role lost `dvir`, `maintenance`, `safety` and
-- `devices` (READ -> NONE, CODE-085). Restores the previous READ levels on that role only;
-- custom roles were never touched.
UPDATE "Role"
SET "permissions" = "permissions"::jsonb
  || '{"dvir":"READ","maintenance":"READ","safety":"READ","devices":"READ"}'::jsonb
WHERE "key" = 'DISPATCHER';
