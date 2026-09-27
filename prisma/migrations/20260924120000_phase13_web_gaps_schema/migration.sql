-- Phase 13A (backend/tasks.md) — schema-only pass so 13C-13I feature agents (RODS, reports,
-- notifications/alerts, vehicles/drivers, trips/geofences/messaging, DVIR/devices/support,
-- auth/users) can start without touching schema.prisma. See backend/decisions.md D- entries
-- for the Terminal-table and org-notification-channel storage calls.

-- CreateEnum
CREATE TYPE "DefectResolutionType" AS ENUM ('REPAIRED', 'NOT_REQUIRED', 'DEFERRED');

-- AlterEnum
ALTER TYPE "ConversationType" ADD VALUE 'SUPPORT';

-- AlterEnum
ALTER TYPE "GeofenceType" ADD VALUE 'ADDRESS';

-- AlterEnum
ALTER TYPE "ReportType" ADD VALUE 'RODS';
ALTER TYPE "ReportType" ADD VALUE 'IDLE_FUEL';

-- AlterEnum
ALTER TYPE "TripStatus" ADD VALUE 'DRAFT';

-- AlterEnum
ALTER TYPE "UnidentifiedStatus" ADD VALUE 'PENDING_CONFIRMATION';

-- AlterTable
ALTER TABLE "AlertRule" ADD COLUMN     "mutedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "kind" TEXT,
ADD COLUMN     "ticketId" TEXT;

-- AlterTable
ALTER TABLE "Carrier" ADD COLUMN     "notificationChannels" JSONB DEFAULT '{}';

-- AlterTable
ALTER TABLE "Defect" ADD COLUMN     "assigneeId" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "correctedBy" TEXT,
ADD COLUMN     "laborHours" DECIMAL(6,2),
ADD COLUMN     "partsCostUsd" DECIMAL(10,2),
ADD COLUMN     "resolutionType" "DefectResolutionType";

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "autoFirmware" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "shareDiagnostics" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Geofence" ADD COLUMN     "address" TEXT,
ADD COLUMN     "afterHoursOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dwellMinutes" INTEGER;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "category" TEXT,
ADD COLUMN     "severity" "AlertSeverity";

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "customer" TEXT,
ADD COLUMN     "distanceMi" DECIMAL(8,2),
ADD COLUMN     "estimatedDriveSec" INTEGER,
ADD COLUMN     "rateUsd" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "UnidentifiedSegment" ADD COLUMN     "confirmationRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatarKey" TEXT,
ADD COLUMN     "homeTerminalName" TEXT,
ADD COLUMN     "preferences" JSONB,
ADD COLUMN     "terminalScope" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "WorkOrder" ADD COLUMN     "blockDispatchAssignment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "estimatedLaborHours" DECIMAL(6,2),
ADD COLUMN     "keepOutOfService" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notifyDriver" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "DriverDocument" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriverDocument_driverId_idx" ON "DriverDocument"("driverId");

-- CreateIndex
CREATE INDEX "Attachment_ticketId_idx" ON "Attachment"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_email_key" ON "Driver"("email");

-- CreateIndex
CREATE INDEX "Notification_category_idx" ON "Notification"("category");

-- AddForeignKey
ALTER TABLE "DriverDocument" ADD CONSTRAINT "DriverDocument_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
