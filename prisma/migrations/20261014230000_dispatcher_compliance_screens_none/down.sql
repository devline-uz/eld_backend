-- Reverts 20261014230000_dispatcher_compliance_screens_none (CODE-085). DATA-ONLY, best effort: the
-- built-in DISPATCHER role gets dvir / maintenance / safety / devices back at READ (the level the
-- migration documents it had). Per-row prior values were not recorded, so a role that had a
-- different level than READ before the migration is not restored exactly.
UPDATE "Role"
SET "permissions" = "permissions"::jsonb
  || '{"dvir":"READ","maintenance":"READ","safety":"READ","devices":"READ"}'::jsonb
WHERE "key" = 'DISPATCHER';
