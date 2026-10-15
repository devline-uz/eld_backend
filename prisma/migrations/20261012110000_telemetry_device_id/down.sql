-- Reverts 20261012110000_telemetry_device_id (D-145). TelemetryPoint is partitioned: DROP INDEX /
-- DROP COLUMN on the parent propagate to every partition.
DROP INDEX "TelemetryPoint_deviceId_time_idx";

ALTER TABLE "TelemetryPoint" DROP COLUMN "deviceId";
