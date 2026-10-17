-- CreateTable
CREATE TABLE "GeofenceVehicle" (
    "geofenceId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,

    CONSTRAINT "GeofenceVehicle_pkey" PRIMARY KEY ("geofenceId","vehicleId")
);

-- CreateIndex
CREATE INDEX "GeofenceVehicle_vehicleId_idx" ON "GeofenceVehicle"("vehicleId");

-- AddForeignKey
ALTER TABLE "GeofenceVehicle" ADD CONSTRAINT "GeofenceVehicle_geofenceId_fkey" FOREIGN KEY ("geofenceId") REFERENCES "Geofence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeofenceVehicle" ADD CONSTRAINT "GeofenceVehicle_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

