-- Reverts 20261012100000_virtual_eld (D-142). Virtual-ELD flags are lost.
DROP INDEX "Device_isVirtual_idx";

ALTER TABLE "Device" DROP COLUMN "isVirtual";

ALTER TABLE "Carrier" DROP COLUMN "virtualEldEnabled",
DROP COLUMN "virtualEldUpdatedAt",
DROP COLUMN "virtualEldUpdatedById";
