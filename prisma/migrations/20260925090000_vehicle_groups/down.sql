ALTER TABLE "Vehicle" DROP CONSTRAINT IF EXISTS "Vehicle_groupId_fkey";
DROP INDEX IF EXISTS "Vehicle_groupId_idx";
ALTER TABLE "Vehicle" DROP COLUMN IF EXISTS "groupId";
DROP TABLE IF EXISTS "VehicleGroup";
