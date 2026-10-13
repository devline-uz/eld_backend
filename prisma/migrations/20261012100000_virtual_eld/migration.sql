-- pt30_pt40/tz.md §9.1 — Virtual ELD (PT Emulator) test mode. Additive only: existing rows get
-- virtualEldEnabled=false / isVirtual=false (D-142). Generated with `prisma migrate diff`
-- against the dev DB (no shadow DB on this host) and checked to contain nothing else.

-- AlterTable
ALTER TABLE "Carrier" ADD COLUMN     "virtualEldEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "virtualEldUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "virtualEldUpdatedById" TEXT;

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "isVirtual" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Device_isVirtual_idx" ON "Device"("isVirtual");
