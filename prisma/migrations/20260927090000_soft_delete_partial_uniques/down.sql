-- DOWN migration for 20260927090000_soft_delete_partial_uniques
-- (runner: scripts/migrate-updown-dev.sh — dev database only, replayed against an empty
-- scratch database).
--
-- NOTE for a real (non-empty) database: recreating the full-table unique indexes FAILS if a
-- unit number / VIN / username / email was reused after a soft delete. Resolve those
-- duplicates first (e.g. rename the soft-deleted row's value) before running this.

-- Drop partial uniques and plain lookup indexes added by the UP
DROP INDEX IF EXISTS "Driver_email_live_key";
DROP INDEX IF EXISTS "Driver_username_live_key";
DROP INDEX IF EXISTS "Vehicle_vin_live_key";
DROP INDEX IF EXISTS "Vehicle_unitNumber_live_key";
DROP INDEX IF EXISTS "Driver_email_idx";
DROP INDEX IF EXISTS "Driver_username_idx";
DROP INDEX IF EXISTS "Vehicle_vin_idx";
DROP INDEX IF EXISTS "Vehicle_unitNumber_idx";

-- Restore the full-table uniques
CREATE UNIQUE INDEX "Vehicle_unitNumber_key" ON "Vehicle"("unitNumber");
CREATE UNIQUE INDEX "Vehicle_vin_key" ON "Vehicle"("vin");
CREATE UNIQUE INDEX "Driver_username_key" ON "Driver"("username");
CREATE UNIQUE INDEX "Driver_email_key" ON "Driver"("email");

-- AlterTable reversals
ALTER TABLE "Driver" DROP COLUMN IF EXISTS "deletedAt";
ALTER TABLE "Vehicle" DROP COLUMN IF EXISTS "deletedAt";
