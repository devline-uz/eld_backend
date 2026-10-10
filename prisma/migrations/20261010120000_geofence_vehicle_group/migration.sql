-- §20 B-104 (web overlay 11.1 "Applies to") — a geofence may target one vehicle group.
-- NULL = applies to every group; deleting the group sets it back to NULL (all groups).
-- Additive only: existing rows stay valid with vehicleGroupId = NULL.

-- AlterTable
ALTER TABLE "Geofence" ADD COLUMN     "vehicleGroupId" TEXT;

-- CreateIndex
CREATE INDEX "Geofence_vehicleGroupId_idx" ON "Geofence"("vehicleGroupId");

-- AddForeignKey
ALTER TABLE "Geofence" ADD CONSTRAINT "Geofence_vehicleGroupId_fkey" FOREIGN KEY ("vehicleGroupId") REFERENCES "VehicleGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
