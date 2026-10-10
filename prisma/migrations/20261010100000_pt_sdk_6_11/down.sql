-- Reverts 20261010100000_pt_sdk_6_11. Destructive for the new columns/table only.
-- NOTE: restoring NOT NULL on TelemetryPoint lat/lon requires deleting null-coordinate rows.
DROP TABLE "DeviceRawEvent";
ALTER TABLE "Device"
  DROP COLUMN "periodicNoBleSec", DROP COLUMN "productName", DROP COLUMN "bleFirmware", DROP COLUMN "imei",
  DROP COLUMN "reportedVin", DROP COLUMN "sdkVersion", DROP COLUMN "appPlatform", DROP COLUMN "connectionType",
  DROP COLUMN "busType", DROP COLUMN "lastInfoAt", DROP COLUMN "harshAccelMg", DROP COLUMN "harshBrakeMg",
  DROP COLUMN "harshCornerMg";
DROP INDEX "DiagnosticTroubleCode_vehicleId_spn_fmi_code_idx";
ALTER TABLE "DiagnosticTroubleCode"
  DROP COLUMN "code", DROP COLUMN "bus", DROP COLUMN "milOn", DROP COLUMN "conversionMethod", DROP COLUMN "active";
DELETE FROM "TelemetryPoint" WHERE "latitude" IS NULL OR "longitude" IS NULL;
ALTER TABLE "TelemetryPoint"
  DROP COLUMN "intakePressureKpa", DROP COLUMN "barometerKpa", DROP COLUMN "fuelTempC", DROP COLUMN "intercoolerTempC",
  DROP COLUMN "turboOilTempC", DROP COLUMN "retarderPct", DROP COLUMN "brakePedal", DROP COLUMN "odometerComputed",
  DROP COLUMN "engineHoursComputed", DROP COLUMN "gpsLocked", DROP COLUMN "gpsSatellites", DROP COLUMN "gpsDop",
  DROP COLUMN "gpsAgeSec";
ALTER TABLE "TelemetryPoint" ALTER COLUMN "latitude" SET NOT NULL, ALTER COLUMN "longitude" SET NOT NULL;
DROP TYPE "DeviceRawEventType";
DROP TYPE "DeviceConnectionType";
