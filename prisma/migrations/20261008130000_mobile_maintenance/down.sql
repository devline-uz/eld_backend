-- Reverts 20261008130000_mobile_maintenance (M-38..M-42). Submitted invoice data is dropped.
DROP INDEX "MaintenanceSchedule_vehicleId_status_idx";
ALTER TABLE "MaintenanceSchedule" DROP CONSTRAINT "MaintenanceSchedule_reviewedById_fkey";
ALTER TABLE "MaintenanceSchedule" DROP CONSTRAINT "MaintenanceSchedule_submittedById_fkey";
ALTER TABLE "MaintenanceSchedule" DROP CONSTRAINT "MaintenanceSchedule_invoiceAttachmentId_fkey";
ALTER TABLE "MaintenanceSchedule"
  DROP COLUMN "reviewedById",
  DROP COLUMN "reviewedAt",
  DROP COLUMN "reviewNote",
  DROP COLUMN "submittedAt",
  DROP COLUMN "submittedById",
  DROP COLUMN "invoiceAttachmentId",
  DROP COLUMN "invoiceNotes",
  DROP COLUMN "cost",
  DROP COLUMN "vendorName",
  DROP COLUMN "invoiceNumber",
  DROP COLUMN "status",
  DROP COLUMN "scheduleType";
DROP TYPE "MaintenanceScheduleStatus";
