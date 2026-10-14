-- Web-user email change (B-84 hardening): pending address + confirm link bound to the request,
-- old-address cancel/revert, post-change reset hold. Same columns as the Driver flow
-- (20261013120000_driver_pending_email). Additive only: existing User rows get NULLs.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailChangedAt" TIMESTAMP(3),
ADD COLUMN     "pendingEmail" TEXT,
ADD COLUMN     "pendingEmailRequestedAt" TIMESTAMP(3),
ADD COLUMN     "pendingEmailRequestedById" TEXT,
ADD COLUMN     "previousEmail" TEXT;

-- CreateIndex
CREATE INDEX "User_pendingEmail_idx" ON "User"("pendingEmail");
