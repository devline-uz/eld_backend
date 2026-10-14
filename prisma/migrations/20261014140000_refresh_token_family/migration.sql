-- MG-32 — refresh-token families: reuse revokes only the family; rotatedAt drives the grace window.
ALTER TABLE "Session" ADD COLUMN "familyId" TEXT, ADD COLUMN "rotatedAt" TIMESTAMP(3);
ALTER TABLE "DriverSession" ADD COLUMN "familyId" TEXT, ADD COLUMN "rotatedAt" TIMESTAMP(3);
CREATE INDEX "Session_familyId_idx" ON "Session"("familyId");
CREATE INDEX "DriverSession_familyId_idx" ON "DriverSession"("familyId");
