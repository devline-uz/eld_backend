-- DOWN migration for 20261014220000_default_hos_violation_alert_rule
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
-- Guarded DELETE: "AlertDelivery"."alertRuleId" is a RESTRICT FK; once delivered, disable instead.
DELETE FROM "AlertRule" r
WHERE r."key" = 'default_hos_violation'
  AND NOT EXISTS (SELECT 1 FROM "AlertDelivery" d WHERE d."alertRuleId" = r."id");
