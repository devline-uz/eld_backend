-- CODE-085: the built-in DISPATCHER role loses `dvir`, `maintenance`, `safety` and `devices`
-- (READ -> NONE). The web never offered DISPATCHER these screens; the API now agrees.
-- Only the system role with key 'DISPATCHER' is touched; custom roles keep what an admin set.
-- Data-only and idempotent: a second run matches no row.
UPDATE "Role"
SET "permissions" = "permissions"::jsonb
  || '{"dvir":"NONE","maintenance":"NONE","safety":"NONE","devices":"NONE"}'::jsonb
WHERE "key" = 'DISPATCHER'
  AND (
    COALESCE("permissions"::jsonb ->> 'dvir', 'NONE') <> 'NONE'
    OR COALESCE("permissions"::jsonb ->> 'maintenance', 'NONE') <> 'NONE'
    OR COALESCE("permissions"::jsonb ->> 'safety', 'NONE') <> 'NONE'
    OR COALESCE("permissions"::jsonb ->> 'devices', 'NONE') <> 'NONE'
  );
