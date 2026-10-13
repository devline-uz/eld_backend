-- pt30_pt40/tz.md §9.5 / D-145 — record which device sent each telemetry point so PT Emulator
-- (Device.isVirtual) telemetry can be told apart and purged. Nullable, no FK (partitioned table,
-- same reasoning as EldEvent B-009); existing rows stay NULL. TelemetryPoint is RANGE-partitioned:
-- ALTER / CREATE INDEX on the parent propagate to every partition.

-- AlterTable
ALTER TABLE "TelemetryPoint" ADD COLUMN     "deviceId" TEXT;

-- CreateIndex
CREATE INDEX "TelemetryPoint_deviceId_time_idx" ON "TelemetryPoint"("deviceId", "time");
