-- Vehicle groups (web W-12 IFTA `Vehicle group` filter, W-13 Activity `Group by`).

-- CreateTable
CREATE TABLE "VehicleGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VehicleGroup_name_key" ON "VehicleGroup"("name");

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN "groupId" TEXT;

-- CreateIndex
CREATE INDEX "Vehicle_groupId_idx" ON "Vehicle"("groupId");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "VehicleGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
