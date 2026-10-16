-- DOWN migration for 20261014150000_device_serial_upper_unique
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- Drops the case-insensitive serial index. The UP also trimmed + upper-cased existing serials;
-- that normalisation is not undone (the original spellings are not kept anywhere).
-- custom-index: drop Device_serial_upper_key
DROP INDEX IF EXISTS "Device_serial_upper_key";
