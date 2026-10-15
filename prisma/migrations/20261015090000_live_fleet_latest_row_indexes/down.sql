-- Reverts 20261015090000_live_fleet_latest_row_indexes (LV-01). Reads stay correct, only slower.
-- custom-index: drop TelemetryPoint_vehicleId_time_fix_idx
DROP INDEX IF EXISTS "TelemetryPoint_vehicleId_time_fix_idx";
-- custom-index: drop EldEvent_driverId_eventDateTime_duty_idx
DROP INDEX IF EXISTS "EldEvent_driverId_eventDateTime_duty_idx";
