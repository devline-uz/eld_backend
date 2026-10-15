-- Reverts 20261014140000_refresh_token_family (MG-32). Family ids / rotation stamps are lost.
DROP INDEX "DriverSession_familyId_idx";
DROP INDEX "Session_familyId_idx";
ALTER TABLE "DriverSession" DROP COLUMN "familyId", DROP COLUMN "rotatedAt";
ALTER TABLE "Session" DROP COLUMN "familyId", DROP COLUMN "rotatedAt";
