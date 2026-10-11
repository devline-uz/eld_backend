-- Revert 20261011164927_driver_score_phase1.
DROP INDEX IF EXISTS "DriverScore_periodEnd_idx";
ALTER TABLE "DriverScore" DROP COLUMN IF EXISTS "computedAt";
ALTER TABLE "DriverScore" DROP COLUMN IF EXISTS "scored";
ALTER TABLE "DriverScore" DROP COLUMN IF EXISTS "seatbeltCount";
