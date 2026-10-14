-- Driver email change: pending address + confirm link, old-address cancel/revert, reset hold.
-- Additive only: every existing Driver row gets NULLs (no pending change, no hold).
-- AlterTable
ALTER TABLE "Driver" ADD COLUMN "pendingEmail" TEXT,
ADD COLUMN "pendingEmailRequestedAt" TIMESTAMP(3),
ADD COLUMN "pendingEmailRequestedById" TEXT,
ADD COLUMN "emailChangedAt" TIMESTAMP(3),
ADD COLUMN "previousEmail" TEXT;

-- CreateIndex
CREATE INDEX "Driver_pendingEmail_idx" ON "Driver"("pendingEmail");
