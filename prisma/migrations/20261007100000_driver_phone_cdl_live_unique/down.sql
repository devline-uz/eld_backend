-- DOWN migration for 20261007100000_driver_phone_cdl_live_unique
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- custom-index: drop Driver_phone_live_key
-- custom-index: drop Driver_cdlNumber_live_key
--
-- The UP created exactly two partial unique indexes; dropping them restores the schema.
-- The UP's de-duplication (cleared duplicate phones, "DUP-<id8>-" licence-number prefixes) is
-- deliberately NOT reversed: the original values are kept in the append-only "AuditLog" rows
-- DRIVER_PHONE_DEDUPLICATED / DRIVER_CDL_DEDUPLICATED (before/after JSON), which must stay.
DROP INDEX IF EXISTS "Driver_phone_live_key";
DROP INDEX IF EXISTS "Driver_cdlNumber_live_key";
