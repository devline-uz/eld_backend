-- BUG-002 — default AlertRule for `alert.eld_status_stale` (raised by DriverRosterService when a
-- duty status stays open past its plausible cap, i.e. the ELD stopped reporting). Without a rule
-- AlertProcessor drops the job. Data-only and idempotent; prisma/seed.ts upserts the same row.
INSERT INTO "AlertRule" ("id", "key", "name", "severity", "conditions", "channels", "recipients", "enabled", "isSystem", "createdAt")
VALUES (gen_random_uuid()::text, 'default_eld_status_stale', 'ELD connection lost', 'WARNING', '[{"event": "alert.eld_status_stale"}]'::jsonb, ARRAY['IN_APP']::text[], '{"roles": ["SUPER_ADMIN", "ADMIN", "FLEET_MANAGER", "DISPATCHER"]}'::jsonb, true, true, NOW())
ON CONFLICT ("key") DO NOTHING;
