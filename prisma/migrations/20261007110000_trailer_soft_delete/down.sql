-- DOWN migration for 20261007110000_trailer_soft_delete
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- custom-index: drop Trailer_number_live_key
--
-- NOTE for a real (non-empty) database: recreating the full-table unique index on "number" FAILS
-- if a trailer number was reused after a soft delete, and dropping "deletedAt" forgets which
-- trailers were soft-deleted (they become live rows again). Resolve both first (e.g. rename or
-- hard-delete the soft-deleted rows) before running this.

-- Drop the partial unique and the plain lookup index added by the UP
DROP INDEX IF EXISTS "Trailer_number_live_key";
DROP INDEX IF EXISTS "Trailer_number_idx";

-- Restore the full-table unique
CREATE UNIQUE INDEX "Trailer_number_key" ON "Trailer"("number");

-- AlterTable reversal
ALTER TABLE "Trailer" DROP COLUMN IF EXISTS "deletedAt";
