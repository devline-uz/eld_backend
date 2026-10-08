-- Mobile wave 4 (2026-10-08), D-129 — M-09/M-12/T-04/T-05: §395.8(d) daily-log header data
-- (shipping documents / trailer numbers) the driver enters on a RODS day with NO active trip,
-- plus the free-text trailer number on a DVIR. Additive only: existing rows stay valid.
CREATE TABLE "DriverDayDetails" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "logDate" DATE NOT NULL,
    "shippingDocuments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trailerNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trailerId" TEXT,
    "bobtail" BOOLEAN NOT NULL DEFAULT false,
    "notes" VARCHAR(60),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverDayDetails_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DriverDayDetails_driverId_logDate_key" ON "DriverDayDetails"("driverId", "logDate");

ALTER TABLE "DriverDayDetails" ADD CONSTRAINT "DriverDayDetails_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Dvir" ADD COLUMN "trailerNumber" TEXT;
