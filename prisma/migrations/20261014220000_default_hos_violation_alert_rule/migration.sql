-- Default AlertRule for `alert.hos_violation` (raised by HosRecalcService when a NEW violation is
-- filed). Without a rule AlertProcessor drops the job and the bell's "Violations" segment stays 0.
-- Data-only and idempotent; prisma/seed.ts upserts the same row.
INSERT INTO "AlertRule" ("id", "key", "name", "severity", "conditions", "channels", "recipients", "enabled", "isSystem", "createdAt")
VALUES (gen_random_uuid()::text, 'default_hos_violation', 'HOS violation', 'CRITICAL', '[{"event": "hos.violation"}]'::jsonb, ARRAY['IN_APP']::text[], '{"roles": ["SUPER_ADMIN", "ADMIN", "FLEET_MANAGER", "DISPATCHER"]}'::jsonb, true, true, NOW())
ON CONFLICT ("key") DO NOTHING;
