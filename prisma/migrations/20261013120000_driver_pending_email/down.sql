-- Reverts 20261013120000_driver_pending_email. Any pending email change is lost.
DROP INDEX "Driver_pendingEmail_idx";

ALTER TABLE "Driver" DROP COLUMN "pendingEmail",
DROP COLUMN "pendingEmailRequestedAt",
DROP COLUMN "pendingEmailRequestedById",
DROP COLUMN "emailChangedAt",
DROP COLUMN "previousEmail";
