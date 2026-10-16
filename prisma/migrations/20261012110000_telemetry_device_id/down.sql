-- DOWN migration for 20261012110000_telemetry_device_id
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- TelemetryPoint is RANGE-partitioned: DROP INDEX / DROP COLUMN on the parent propagate to
-- every partition.
DROP INDEX IF EXISTS "TelemetryPoint_deviceId_time_idx";
ALTER TABLE "TelemetryPoint" DROP COLUMN IF EXISTS "deviceId";
