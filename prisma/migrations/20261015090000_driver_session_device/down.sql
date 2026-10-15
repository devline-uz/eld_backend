-- Reverts 20261015090000_driver_session_device (MD-195).
DROP INDEX IF EXISTS "DriverSession_driverId_deviceId_idx";

ALTER TABLE "DriverSession"
  DROP COLUMN IF EXISTS "deviceId",
  DROP COLUMN IF EXISTS "platform",
  DROP COLUMN IF EXISTS "formFactor",
  DROP COLUMN IF EXISTS "createdAt",
  DROP COLUMN IF EXISTS "revokedReason",
  DROP COLUMN IF EXISTS "replacedByDeviceId",
  DROP COLUMN IF EXISTS "replacedByDeviceLabel",
  DROP COLUMN IF EXISTS "lastMotionAt",
  DROP COLUMN IF EXISTS "pendingCount",
  DROP COLUMN IF EXISTS "oldestPendingAt";
