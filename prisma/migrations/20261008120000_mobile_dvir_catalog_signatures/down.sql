-- Reverts 20261008120000_mobile_dvir_catalog_signatures (MR-9/10/11/27).
DROP TABLE "DriverSavedSignature";
DROP TABLE "DefectCatalogItem";
ALTER TABLE "Dvir" DROP COLUMN "mechanicSignatureHash";
ALTER TABLE "Dvir" DROP COLUMN "mechanicSignatureUrl";
-- Rows submitted without an odometer have NULL; restore NOT NULL with 0 for them (lossy, rollback only).
UPDATE "Dvir" SET "odometerMi" = 0 WHERE "odometerMi" IS NULL;
ALTER TABLE "Dvir" ALTER COLUMN "odometerMi" SET NOT NULL;
