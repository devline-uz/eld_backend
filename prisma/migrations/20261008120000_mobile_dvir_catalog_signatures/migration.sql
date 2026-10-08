-- MR-9 / MR-10 / MR-11 / MR-27 (docs/mobile-requests-2026-10-08.md). Additive except Dvir.odometerMi -> NULLable.
-- MR-11: DVIR odometer is optional in the app.
ALTER TABLE "Dvir" ALTER COLUMN "odometerMi" DROP NOT NULL;

-- MR-10: mechanic signature captured at submit time (object-storage key + sha256).
ALTER TABLE "Dvir" ADD COLUMN "mechanicSignatureUrl" TEXT;
ALTER TABLE "Dvir" ADD COLUMN "mechanicSignatureHash" TEXT;

-- MR-9: defect catalog.
CREATE TABLE "DefectCatalogItem" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "part" "DefectPart" NOT NULL,
  "category" TEXT,
  "critical" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "DefectCatalogItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DefectCatalogItem_part_code_key" ON "DefectCatalogItem"("part", "code");
CREATE INDEX "DefectCatalogItem_part_active_sortOrder_idx" ON "DefectCatalogItem"("part", "active", "sortOrder");

-- Default catalog = the app's hard-coded FMCSA 396.11 list (32 truck + 15 trailer items).
INSERT INTO "DefectCatalogItem" ("id", "code", "name", "part", "category", "critical", "sortOrder") VALUES
  (gen_random_uuid(), 'AIR_LINES', 'Air lines', 'TRUCK', 'Brakes', true, 10),
  (gen_random_uuid(), 'BATTERY', 'Battery', 'TRUCK', 'Electrical', false, 20),
  (gen_random_uuid(), 'BRAKES_PARKING', 'Brakes, Parking', 'TRUCK', 'Brakes', true, 30),
  (gen_random_uuid(), 'BRAKES_SERVICE', 'Brakes, Service', 'TRUCK', 'Brakes', true, 40),
  (gen_random_uuid(), 'CLUTCH', 'Clutch', 'TRUCK', 'Drivetrain', false, 50),
  (gen_random_uuid(), 'COUPLING_DEVICE', 'Coupling device', 'TRUCK', 'Coupling', true, 60),
  (gen_random_uuid(), 'DEFROSTER_HEATER', 'Defroster/Heater', 'TRUCK', 'Cab', false, 70),
  (gen_random_uuid(), 'ENGINE', 'Engine', 'TRUCK', 'Engine', false, 80),
  (gen_random_uuid(), 'EXHAUST', 'Exhaust', 'TRUCK', 'Engine', false, 90),
  (gen_random_uuid(), 'FIFTH_WHEEL', 'Fifth wheel', 'TRUCK', 'Coupling', true, 100),
  (gen_random_uuid(), 'FLUID_LEVELS', 'Fluid levels', 'TRUCK', 'Engine', false, 110),
  (gen_random_uuid(), 'FRAME_ASSEMBLY', 'Frame & assembly', 'TRUCK', 'Chassis', true, 120),
  (gen_random_uuid(), 'FUEL_TANKS', 'Fuel tanks', 'TRUCK', 'Engine', false, 130),
  (gen_random_uuid(), 'HORN', 'Horn', 'TRUCK', 'Cab', false, 140),
  (gen_random_uuid(), 'LIGHTS_HEAD_STOP', 'Lights (Head - Stop)', 'TRUCK', 'Lights', true, 150),
  (gen_random_uuid(), 'LIGHTS_TURN_MARKER', 'Lights (Turn - Marker)', 'TRUCK', 'Lights', false, 160),
  (gen_random_uuid(), 'MIRRORS', 'Mirrors', 'TRUCK', 'Cab', false, 170),
  (gen_random_uuid(), 'OIL_PRESSURE', 'Oil pressure', 'TRUCK', 'Engine', false, 180),
  (gen_random_uuid(), 'RADIATOR', 'Radiator', 'TRUCK', 'Engine', false, 190),
  (gen_random_uuid(), 'REAR_END', 'Rear end', 'TRUCK', 'Drivetrain', false, 200),
  (gen_random_uuid(), 'REFLECTORS', 'Reflectors', 'TRUCK', 'Lights', false, 210),
  (gen_random_uuid(), 'SAFETY_EQUIPMENT', 'Safety equipment', 'TRUCK', 'Safety', false, 220),
  (gen_random_uuid(), 'STARTER', 'Starter', 'TRUCK', 'Electrical', false, 230),
  (gen_random_uuid(), 'STEERING', 'Steering', 'TRUCK', 'Steering', true, 240),
  (gen_random_uuid(), 'SUSPENSION', 'Suspension', 'TRUCK', 'Chassis', true, 250),
  (gen_random_uuid(), 'TIRES', 'Tires', 'TRUCK', 'Tires & wheels', true, 260),
  (gen_random_uuid(), 'TRANSMISSION', 'Transmission', 'TRUCK', 'Drivetrain', false, 270),
  (gen_random_uuid(), 'TRIP_RECORDER', 'Trip recorder', 'TRUCK', 'Cab', false, 280),
  (gen_random_uuid(), 'WHEELS_RIMS', 'Wheels & rims', 'TRUCK', 'Tires & wheels', true, 290),
  (gen_random_uuid(), 'WINDOWS', 'Windows', 'TRUCK', 'Cab', false, 300),
  (gen_random_uuid(), 'WINDSHIELD_WIPERS', 'Windshield wipers', 'TRUCK', 'Cab', false, 310),
  (gen_random_uuid(), 'OTHER', 'Other', 'TRUCK', NULL, false, 320),
  (gen_random_uuid(), 'BRAKE_CONNECTIONS', 'Brake connections', 'TRAILER', 'Brakes', true, 10),
  (gen_random_uuid(), 'BRAKES', 'Brakes', 'TRAILER', 'Brakes', true, 20),
  (gen_random_uuid(), 'COUPLING_DEVICES', 'Coupling devices', 'TRAILER', 'Coupling', true, 30),
  (gen_random_uuid(), 'COUPLING_KING_PIN', 'Coupling (king) pin', 'TRAILER', 'Coupling', true, 40),
  (gen_random_uuid(), 'DOORS', 'Doors', 'TRAILER', 'Body', false, 50),
  (gen_random_uuid(), 'HITCH', 'Hitch', 'TRAILER', 'Coupling', true, 60),
  (gen_random_uuid(), 'LANDING_GEAR', 'Landing gear', 'TRAILER', 'Chassis', false, 70),
  (gen_random_uuid(), 'LIGHTS', 'Lights', 'TRAILER', 'Lights', false, 80),
  (gen_random_uuid(), 'REFLECTORS', 'Reflectors', 'TRAILER', 'Lights', false, 90),
  (gen_random_uuid(), 'ROOF', 'Roof', 'TRAILER', 'Body', false, 100),
  (gen_random_uuid(), 'SUSPENSION', 'Suspension', 'TRAILER', 'Chassis', true, 110),
  (gen_random_uuid(), 'TARPAULIN', 'Tarpaulin', 'TRAILER', 'Body', false, 120),
  (gen_random_uuid(), 'TIRES', 'Tires', 'TRAILER', 'Tires & wheels', true, 130),
  (gen_random_uuid(), 'WHEELS_RIMS', 'Wheels & rims', 'TRAILER', 'Tires & wheels', true, 140),
  (gen_random_uuid(), 'OTHER', 'Other', 'TRAILER', NULL, false, 150)
ON CONFLICT ("part", "code") DO NOTHING;

-- MR-27: driver's saved signature.
CREATE TABLE "DriverSavedSignature" (
  "driverId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DriverSavedSignature_pkey" PRIMARY KEY ("driverId")
);
ALTER TABLE "DriverSavedSignature" ADD CONSTRAINT "DriverSavedSignature_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
