-- DOWN migration for 20260924120000_phase13_web_gaps_schema
-- (runner: scripts/migrate-updown-dev.sh — dev database only, replayed against an empty
-- scratch database, so no data-preservation concerns here).
--
-- Reverses the UP in the opposite order: FKs, new indexes, new table, new/altered
-- columns, then the four ADD VALUE enum extensions (Postgres has no native "DROP VALUE",
-- so each of those rebuilds the type from the pre-13 value list and repoints every column
-- that used it).

-- Drop foreign keys added by the UP
ALTER TABLE "Attachment" DROP CONSTRAINT IF EXISTS "Attachment_ticketId_fkey";
ALTER TABLE "Report" DROP CONSTRAINT IF EXISTS "Report_requestedById_fkey";
ALTER TABLE "DriverDocument" DROP CONSTRAINT IF EXISTS "DriverDocument_driverId_fkey";

-- Drop indexes added by the UP
DROP INDEX IF EXISTS "Notification_category_idx";
DROP INDEX IF EXISTS "Driver_email_key";
DROP INDEX IF EXISTS "Attachment_ticketId_idx";
DROP INDEX IF EXISTS "DriverDocument_driverId_idx";

-- Drop the new table
DROP TABLE IF EXISTS "DriverDocument";

-- AlterTable reversals
ALTER TABLE "WorkOrder" DROP COLUMN IF EXISTS "notifyDriver";
ALTER TABLE "WorkOrder" DROP COLUMN IF EXISTS "keepOutOfService";
ALTER TABLE "WorkOrder" DROP COLUMN IF EXISTS "estimatedLaborHours";
ALTER TABLE "WorkOrder" DROP COLUMN IF EXISTS "blockDispatchAssignment";

ALTER TABLE "User" DROP COLUMN IF EXISTS "terminalScope";
ALTER TABLE "User" DROP COLUMN IF EXISTS "preferences";
ALTER TABLE "User" DROP COLUMN IF EXISTS "homeTerminalName";
ALTER TABLE "User" DROP COLUMN IF EXISTS "avatarKey";

ALTER TABLE "UnidentifiedSegment" DROP COLUMN IF EXISTS "confirmationRequestedAt";

ALTER TABLE "Trip" DROP COLUMN IF EXISTS "rateUsd";
ALTER TABLE "Trip" DROP COLUMN IF EXISTS "estimatedDriveSec";
ALTER TABLE "Trip" DROP COLUMN IF EXISTS "distanceMi";
ALTER TABLE "Trip" DROP COLUMN IF EXISTS "customer";

ALTER TABLE "Notification" DROP COLUMN IF EXISTS "severity";
ALTER TABLE "Notification" DROP COLUMN IF EXISTS "category";

ALTER TABLE "Geofence" DROP COLUMN IF EXISTS "dwellMinutes";
ALTER TABLE "Geofence" DROP COLUMN IF EXISTS "afterHoursOnly";
ALTER TABLE "Geofence" DROP COLUMN IF EXISTS "address";

ALTER TABLE "Driver" DROP COLUMN IF EXISTS "emailVerifiedAt";

ALTER TABLE "Device" DROP COLUMN IF EXISTS "shareDiagnostics";
ALTER TABLE "Device" DROP COLUMN IF EXISTS "autoFirmware";

ALTER TABLE "Defect" DROP COLUMN IF EXISTS "resolutionType";
ALTER TABLE "Defect" DROP COLUMN IF EXISTS "partsCostUsd";
ALTER TABLE "Defect" DROP COLUMN IF EXISTS "laborHours";
ALTER TABLE "Defect" DROP COLUMN IF EXISTS "correctedBy";
ALTER TABLE "Defect" DROP COLUMN IF EXISTS "completedAt";
ALTER TABLE "Defect" DROP COLUMN IF EXISTS "assigneeId";

ALTER TABLE "Carrier" DROP COLUMN IF EXISTS "notificationChannels";

ALTER TABLE "Attachment" DROP COLUMN IF EXISTS "ticketId";
ALTER TABLE "Attachment" DROP COLUMN IF EXISTS "kind";

ALTER TABLE "AlertRule" DROP COLUMN IF EXISTS "mutedUntil";

-- AlterEnum reversals: rebuild each type from its pre-13 value list and repoint the
-- one column (with its default) that uses it. Postgres cannot DROP VALUE directly.

-- UnidentifiedStatus: drop PENDING_CONFIRMATION
CREATE TYPE "UnidentifiedStatus_old" AS ENUM ('PENDING', 'ASSIGNED', 'REJECTED', 'ANNOTATED');
ALTER TABLE "UnidentifiedSegment" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "UnidentifiedSegment" ALTER COLUMN "status" TYPE "UnidentifiedStatus_old" USING ("status"::text::"UnidentifiedStatus_old");
ALTER TABLE "UnidentifiedSegment" ALTER COLUMN "status" SET DEFAULT 'PENDING';
DROP TYPE "UnidentifiedStatus";
ALTER TYPE "UnidentifiedStatus_old" RENAME TO "UnidentifiedStatus";

-- TripStatus: drop DRAFT
CREATE TYPE "TripStatus_old" AS ENUM ('PLANNED', 'ASSIGNED', 'IN_PROGRESS', 'DELIVERED', 'CANCELLED');
ALTER TABLE "Trip" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Trip" ALTER COLUMN "status" TYPE "TripStatus_old" USING ("status"::text::"TripStatus_old");
ALTER TABLE "Trip" ALTER COLUMN "status" SET DEFAULT 'PLANNED';
DROP TYPE "TripStatus";
ALTER TYPE "TripStatus_old" RENAME TO "TripStatus";

-- ReportType: drop RODS, IDLE_FUEL
CREATE TYPE "ReportType_old" AS ENUM ('IFTA', 'ACTIVITY', 'DVIR', 'FMCSA_PACK', 'UNIDENTIFIED', 'SAFETY');
ALTER TABLE "Report" ALTER COLUMN "type" TYPE "ReportType_old" USING ("type"::text::"ReportType_old");
ALTER TABLE "ReportSchedule" ALTER COLUMN "reportType" TYPE "ReportType_old" USING ("reportType"::text::"ReportType_old");
DROP TYPE "ReportType";
ALTER TYPE "ReportType_old" RENAME TO "ReportType";

-- GeofenceType: drop ADDRESS
CREATE TYPE "GeofenceType_old" AS ENUM ('CIRCLE', 'POLYGON');
ALTER TABLE "Geofence" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "Geofence" ALTER COLUMN "type" TYPE "GeofenceType_old" USING ("type"::text::"GeofenceType_old");
ALTER TABLE "Geofence" ALTER COLUMN "type" SET DEFAULT 'CIRCLE';
DROP TYPE "GeofenceType";
ALTER TYPE "GeofenceType_old" RENAME TO "GeofenceType";

-- ConversationType: drop SUPPORT
CREATE TYPE "ConversationType_old" AS ENUM ('DIRECT', 'GROUP', 'BROADCAST');
ALTER TABLE "Conversation" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "Conversation" ALTER COLUMN "type" TYPE "ConversationType_old" USING ("type"::text::"ConversationType_old");
ALTER TABLE "Conversation" ALTER COLUMN "type" SET DEFAULT 'DIRECT';
DROP TYPE "ConversationType";
ALTER TYPE "ConversationType_old" RENAME TO "ConversationType";

-- CreateEnum reversal
DROP TYPE IF EXISTS "DefectResolutionType";
