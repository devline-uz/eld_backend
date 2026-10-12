-- DOWN migration for 20261012100000_default_eld_status_stale_alert_rule
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- The UP is data-only (one idempotent INSERT), so the reverse is a guarded DELETE: the rule is
-- removed only while NO delivery references it ("AlertDelivery"."alertRuleId" is a RESTRICT FK).
-- Once it has delivered, disable it from the Alert rules page instead.
DELETE FROM "AlertRule" r
WHERE r."key" = 'default_eld_status_stale'
  AND NOT EXISTS (SELECT 1 FROM "AlertDelivery" d WHERE d."alertRuleId" = r."id");
