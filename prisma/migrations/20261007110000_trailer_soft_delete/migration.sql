-- Soft-delete for Trailer, with the trailer number reusable after a soft delete.
--
-- `DELETE /trailers/:id` used to hard-delete the row, which failed (FK "Dvir_trailerId_fkey",
-- ON DELETE RESTRICT) as soon as any DVIR referenced the trailer, and would have orphaned the
-- FK-less "Trip"."trailerId". It now sets "deletedAt" instead (same pattern as Vehicle / Driver in
-- 20260927090000_soft_delete_partial_uniques). This migration:
--   1. adds a nullable "deletedAt" marker (TIMESTAMP(3), UTC — the same column type every other
--      Prisma `DateTime` in this schema uses, including "Vehicle"."deletedAt");
--   2. swaps the full-table unique index on "number" for a PARTIAL unique index that only covers
--      live rows ("deletedAt" IS NULL), plus a plain lookup index matching `@@index([number])`.
--      "vin" was never unique on Trailer, so nothing changes for it.
--
-- Prisma's schema language can't express partial indexes, so "Trailer_number_live_key" exists
-- only here. It is whitelisted in src/core/prisma/custom-indexes.ts, so `npm run migrate:dev`
-- strips any DROP/CREATE of it from a generated migration.
--
-- Safety: no row is deleted or modified; existing data already satisfies the stricter full-table
-- uniqueness, so the partial (weaker) index cannot fail on existing rows.

-- AlterTable
ALTER TABLE "Trailer" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- DropIndex (full-table unique)
DROP INDEX "Trailer_number_key";

-- CreateIndex (plain lookup index — mirrored by `@@index([number])` in schema.prisma)
CREATE INDEX "Trailer_number_idx" ON "Trailer"("number");

-- CreateIndex (partial unique — live rows only; NOT representable in schema.prisma)
CREATE UNIQUE INDEX "Trailer_number_live_key" ON "Trailer"("number") WHERE "deletedAt" IS NULL;
