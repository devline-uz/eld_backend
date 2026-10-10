-- PT SDK 6.11.1 alignment (2026-10-10). Additive only.
-- TelemetryPoint is RANGE-partitioned: ALTER on the parent propagates to partitions.
CREATE TYPE "DeviceConnectionType" AS ENUM ('BLE', 'USB');
CREATE TYPE "DeviceRawEventType" AS ENUM ('POWER_ON','POWER_OFF','IGNITION_ON','IGNITION_OFF','ENGINE_ON','ENGINE_OFF','TRIP_START','TRIP_END','PERIODIC','BLE_ON','BLE_OFF','BUS_ON','BUS_OFF','HARSH_ACCEL','HARSH_BRAKE','HARSH_CORNER','INTERMEDIATE','UNKNOWN');

ALTER TABLE "TelemetryPoint" ALTER COLUMN "latitude" DROP NOT NULL, ALTER COLUMN "longitude" DROP NOT NULL;
ALTER TABLE "TelemetryPoint"
  ADD COLUMN "intakePressureKpa" DECIMAL(6,1),
  ADD COLUMN "barometerKpa" DECIMAL(5,1),
  ADD COLUMN "fuelTempC" INTEGER,
  ADD COLUMN "intercoolerTempC" INTEGER,
  ADD COLUMN "turboOilTempC" INTEGER,
  ADD COLUMN "retarderPct" INTEGER,
  ADD COLUMN "brakePedal" INTEGER,
  ADD COLUMN "odometerComputed" BOOLEAN,
  ADD COLUMN "engineHoursComputed" BOOLEAN,
  ADD COLUMN "gpsLocked" BOOLEAN,
  ADD COLUMN "gpsSatellites" INTEGER,
  ADD COLUMN "gpsDop" DECIMAL(4,1),
  ADD COLUMN "gpsAgeSec" INTEGER;

ALTER TABLE "DiagnosticTroubleCode"
  ADD COLUMN "code" TEXT,
  ADD COLUMN "bus" "BusType",
  ADD COLUMN "milOn" BOOLEAN,
  ADD COLUMN "conversionMethod" INTEGER,
  ADD COLUMN "active" BOOLEAN;
CREATE INDEX "DiagnosticTroubleCode_vehicleId_spn_fmi_code_idx" ON "DiagnosticTroubleCode"("vehicleId", "spn", "fmi", "code");

ALTER TABLE "Device"
  ADD COLUMN "periodicNoBleSec" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "productName" TEXT,
  ADD COLUMN "bleFirmware" TEXT,
  ADD COLUMN "imei" TEXT,
  ADD COLUMN "reportedVin" TEXT,
  ADD COLUMN "sdkVersion" TEXT,
  ADD COLUMN "appPlatform" "AppPlatform",
  ADD COLUMN "connectionType" "DeviceConnectionType",
  ADD COLUMN "busType" "BusType",
  ADD COLUMN "lastInfoAt" TIMESTAMP(3),
  ADD COLUMN "harshAccelMg" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "harshBrakeMg" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "harshCornerMg" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "DeviceRawEvent" (
    "id" BIGSERIAL NOT NULL,
    "deviceId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "type" "DeviceRawEventType" NOT NULL,
    "seq" INTEGER NOT NULL,
    "hsi" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "live" BOOLEAN NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "headingDeg" INTEGER,
    "gpsLocked" BOOLEAN,
    "gpsSatellites" INTEGER,
    "gpsDop" DECIMAL(4,1),
    "gpsAgeSec" INTEGER,
    "odometerKm" DECIMAL(12,1),
    "speedKmh" INTEGER,
    "engineHours" DECIMAL(10,2),
    "rpm" INTEGER,
    "obd2" BOOLEAN,
    "engineAgeSec" INTEGER,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeviceRawEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeviceRawEvent_deviceId_occurredAt_seq_key" ON "DeviceRawEvent"("deviceId", "occurredAt", "seq");
CREATE INDEX "DeviceRawEvent_vehicleId_occurredAt_idx" ON "DeviceRawEvent"("vehicleId", "occurredAt");
CREATE INDEX "DeviceRawEvent_deviceId_occurredAt_idx" ON "DeviceRawEvent"("deviceId", "occurredAt");
ALTER TABLE "DeviceRawEvent" ADD CONSTRAINT "DeviceRawEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
