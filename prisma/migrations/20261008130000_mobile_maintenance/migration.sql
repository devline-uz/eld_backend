-- M-38..M-42 (mobile wave 4, 2026-10-08): driver maintenance tasks + invoice submission.
-- Additive only: every existing schedule becomes status OPEN / scheduleType SERVICE.
CREATE TYPE "MaintenanceScheduleStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED', 'REJECTED');

ALTER TABLE "MaintenanceSchedule"
  ADD COLUMN "scheduleType" VARCHAR(40) NOT NULL DEFAULT 'SERVICE',
  ADD COLUMN "status" "MaintenanceScheduleStatus" NOT NULL DEFAULT 'OPEN',
  ADD COLUMN "invoiceNumber" VARCHAR(60),
  ADD COLUMN "vendorName" VARCHAR(120),
  ADD COLUMN "cost" DECIMAL(10, 2),
  ADD COLUMN "invoiceNotes" VARCHAR(1000),
  ADD COLUMN "invoiceAttachmentId" TEXT,
  ADD COLUMN "submittedById" TEXT,
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "reviewNote" VARCHAR(500),
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedById" TEXT;

ALTER TABLE "MaintenanceSchedule" ADD CONSTRAINT "MaintenanceSchedule_invoiceAttachmentId_fkey" FOREIGN KEY ("invoiceAttachmentId") REFERENCES "Attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MaintenanceSchedule" ADD CONSTRAINT "MaintenanceSchedule_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MaintenanceSchedule" ADD CONSTRAINT "MaintenanceSchedule_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "MaintenanceSchedule_vehicleId_status_idx" ON "MaintenanceSchedule"("vehicleId", "status");
