-- Soft-delete for Vehicle and Driver, with unique values reusable after a soft delete.
--
-- Web `DELETE /vehicles/:id` and `DELETE /drivers/:id` are soft deletes (bugs.md B-009: a hard
-- DELETE breaks on the EldEvent FK under the append-only REVOKE). Until now the soft-deleted row
-- kept holding its full-table unique keys, so a carrier could never re-add a truck with the same
-- unit number / VIN, or re-hire a driver under the same username / email. This migration:
--   1. adds a nullable "deletedAt" marker to both tables;
--   2. backfills Driver."deletedAt" for rows the web already soft-deleted (status TERMINATED);
--      Vehicle is NOT backfilled — status INACTIVE is also set by plain edits / bulk-status, so
--      it does not reliably mean "deleted";
--   3. swaps the four full-table unique indexes for PARTIAL unique indexes that only cover live
--      rows ("deletedAt" IS NULL), plus plain non-unique lookup indexes matching the
--      `@@index` entries in schema.prisma.
--
-- Prisma's schema language can't express partial indexes, so the four "*_live_key" indexes
-- below exist only here. A future `prisma migrate dev` will propose DROPping them — delete
-- those statements from any generated migration by hand.
--
-- Safety: every index is created after the old full-table unique index is dropped, but the
-- data already satisfies the stricter full-table uniqueness, so the partial (weaker)
-- constraints cannot fail on existing rows.

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Driver" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Backfill: drivers already soft-deleted by the web (status flip to TERMINATED).
UPDATE "Driver" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "status" = 'TERMINATED' AND "deletedAt" IS NULL;

-- DropIndex (full-table uniques)
DROP INDEX "Vehicle_unitNumber_key";
DROP INDEX "Vehicle_vin_key";
DROP INDEX "Driver_username_key";
DROP INDEX "Driver_email_key";

-- CreateIndex (plain lookup indexes — mirrored by `@@index` in schema.prisma)
CREATE INDEX "Vehicle_unitNumber_idx" ON "Vehicle"("unitNumber");
CREATE INDEX "Vehicle_vin_idx" ON "Vehicle"("vin");
CREATE INDEX "Driver_username_idx" ON "Driver"("username");
CREATE INDEX "Driver_email_idx" ON "Driver"("email");

-- CreateIndex (partial uniques — live rows only; NOT representable in schema.prisma)
CREATE UNIQUE INDEX "Vehicle_unitNumber_live_key" ON "Vehicle"("unitNumber") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Vehicle_vin_live_key" ON "Vehicle"("vin") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Driver_username_live_key" ON "Driver"("username") WHERE "deletedAt" IS NULL;
-- "email" is nullable: NULLs stay distinct under a unique index, so any number of live
-- drivers may have no email.
CREATE UNIQUE INDEX "Driver_email_live_key" ON "Driver"("email") WHERE "deletedAt" IS NULL;
