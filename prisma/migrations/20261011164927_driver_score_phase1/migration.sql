-- D-133 — W-10 scorecards Phase 1: seatbelt count, scored flag (< 100 mi = no score), computedAt,
-- and an index for the "latest period" read. Additive only; existing rows stay valid (scored = true).

-- AlterTable
ALTER TABLE "DriverScore" ADD COLUMN     "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "scored" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "seatbeltCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "DriverScore_periodEnd_idx" ON "DriverScore"("periodEnd");
