-- Reverts 20261008100000_trip_mobile_arrays (MR-4).
ALTER TABLE "Trip" DROP COLUMN "shippingDocuments",
DROP COLUMN "trailerNumbers",
DROP COLUMN "bobtail";
