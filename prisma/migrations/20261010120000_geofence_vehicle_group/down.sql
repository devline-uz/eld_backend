-- Revert 20261010120000_geofence_vehicle_group.
ALTER TABLE "Geofence" DROP CONSTRAINT IF EXISTS "Geofence_vehicleGroupId_fkey";
DROP INDEX IF EXISTS "Geofence_vehicleGroupId_idx";
ALTER TABLE "Geofence" DROP COLUMN IF EXISTS "vehicleGroupId";
