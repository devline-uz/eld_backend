-- MD-195: one driver account = one signed-in device. Additive, nullable columns only.
ALTER TABLE "DriverSession"
  ADD COLUMN "deviceId" TEXT,
  ADD COLUMN "platform" TEXT,
  ADD COLUMN "formFactor" TEXT,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "revokedReason" TEXT,
  ADD COLUMN "replacedByDeviceId" TEXT,
  ADD COLUMN "replacedByDeviceLabel" TEXT,
  ADD COLUMN "lastMotionAt" TIMESTAMP(3),
  ADD COLUMN "pendingCount" INTEGER,
  ADD COLUMN "oldestPendingAt" TIMESTAMP(3);

CREATE INDEX "DriverSession_driverId_deviceId_idx" ON "DriverSession"("driverId", "deviceId");
