-- CreateEnum
CREATE TYPE "HosRuleset" AS ENUM ('US_70_8_PROPERTY', 'US_60_7_PROPERTY', 'US_70_8_PASSENGER', 'US_60_7_PASSENGER');

-- CreateEnum
CREATE TYPE "DistanceUnit" AS ENUM ('MILES', 'KILOMETERS');

-- CreateEnum
CREATE TYPE "ErodsMode" AS ENUM ('TEST', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('PASSWORD', 'GOOGLE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'OUT_OF_SERVICE');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('UNASSIGNED', 'ASSIGNED', 'FAULTY', 'RETIRED');

-- CreateEnum
CREATE TYPE "DeviceModel" AS ENUM ('PT30', 'PT40');

-- CreateEnum
CREATE TYPE "BleState" AS ENUM ('CONNECTED', 'OUT_OF_RANGE', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "BusType" AS ENUM ('J1939', 'J1708', 'OBD_II');

-- CreateEnum
CREATE TYPE "FuelType" AS ENUM ('DIESEL', 'GASOLINE', 'CNG', 'LNG', 'ELECTRIC');

-- CreateEnum
CREATE TYPE "AppPlatform" AS ENUM ('IOS', 'ANDROID');

-- CreateEnum
CREATE TYPE "EditorType" AS ENUM ('DRIVER', 'USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "DutyStatus" AS ENUM ('OFF', 'SB', 'D', 'ON');

-- CreateEnum
CREATE TYPE "ViolationType" AS ENUM ('DRIVING_11', 'SHIFT_14', 'BREAK_30', 'CYCLE_70', 'CYCLE_60', 'FORM_MANNER');

-- CreateEnum
CREATE TYPE "ViolationStatus" AS ENUM ('OPEN', 'RESOLVED', 'AUTO_CLEARED');

-- CreateEnum
CREATE TYPE "UnidentifiedStatus" AS ENUM ('PENDING', 'ASSIGNED', 'REJECTED', 'ANNOTATED');

-- CreateEnum
CREATE TYPE "DvirType" AS ENUM ('PRE_TRIP', 'POST_TRIP', 'INTERMEDIATE');

-- CreateEnum
CREATE TYPE "DvirCondition" AS ENUM ('SATISFACTORY', 'DEFECTS_FOUND');

-- CreateEnum
CREATE TYPE "RepairStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'REPAIRED', 'DEFERRED');

-- CreateEnum
CREATE TYPE "DefectPart" AS ENUM ('TRUCK', 'TRAILER');

-- CreateEnum
CREATE TYPE "DefectSeverity" AS ENUM ('MINOR', 'MAJOR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "DefectStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'REPAIRED', 'DEFERRED');

-- CreateEnum
CREATE TYPE "WorkOrderPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('PLANNED', 'ASSIGNED', 'IN_PROGRESS', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StopType" AS ENUM ('PICKUP', 'DELIVERY', 'FUEL', 'REST', 'CHECKPOINT');

-- CreateEnum
CREATE TYPE "StopStatus" AS ENUM ('PENDING', 'ARRIVED', 'COMPLETED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "GeofenceType" AS ENUM ('CIRCLE', 'POLYGON');

-- CreateEnum
CREATE TYPE "SafetyEventType" AS ENUM ('HARSH_BRAKING', 'HARSH_ACCEL', 'HARSH_TURN', 'SPEEDING', 'SEATBELT');

-- CreateEnum
CREATE TYPE "CoachingStatus" AS ENUM ('NEW', 'REVIEWED', 'COACHED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('DIRECT', 'GROUP', 'BROADCAST');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('CRITICAL', 'WARNING', 'INFO');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('IFTA', 'ACTIVITY', 'DVIR', 'FMCSA_PACK', 'UNIDENTIFIED', 'SAFETY');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('PDF', 'CSV', 'XLSX');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "TransferMethod" AS ENUM ('WEB_SERVICES', 'EMAIL');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('QUEUED', 'TEST_ONLY', 'SENT', 'ACCEPTED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('DISCONNECTED', 'CONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateTable
CREATE TABLE "Carrier" (
    "id" TEXT NOT NULL DEFAULT 'carrier',
    "name" TEXT NOT NULL,
    "dotNumber" TEXT NOT NULL,
    "mcNumber" TEXT,
    "ein" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "hosRuleset" "HosRuleset" NOT NULL DEFAULT 'US_70_8_PROPERTY',
    "distanceUnit" "DistanceUnit" NOT NULL DEFAULT 'MILES',
    "cycleRestart" BOOLEAN NOT NULL DEFAULT true,
    "unassignedThresholdMin" INTEGER NOT NULL DEFAULT 3,
    "dvirRetentionMonths" INTEGER NOT NULL DEFAULT 24,
    "allowPersonalConveyance" BOOLEAN NOT NULL DEFAULT true,
    "allowYardMove" BOOLEAN NOT NULL DEFAULT true,
    "addressLine1" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "phone" TEXT,
    "complianceEmail" TEXT,
    "logoUrl" TEXT,
    "eldIdentifier" VARCHAR(4) NOT NULL DEFAULT 'OBK1',
    "eldRegistrationId" VARCHAR(4),
    "erodsMode" "ErodsMode" NOT NULL DEFAULT 'TEST',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Carrier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "googleUid" TEXT,
    "authProvider" "AuthProvider" NOT NULL DEFAULT 'PASSWORD',
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "jobTitle" TEXT,
    "phone" TEXT,
    "roleId" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "twoFactorSecret" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "recoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastActiveAt" TIMESTAMP(3),
    "invitedById" TEXT,
    "invitedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "deviceLabel" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverSession" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "deviceLabel" TEXT,
    "appVersion" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DriverSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "cdlNumber" TEXT NOT NULL,
    "cdlState" TEXT NOT NULL,
    "status" "DriverStatus" NOT NULL DEFAULT 'ACTIVE',
    "homeTerminalName" TEXT NOT NULL,
    "homeTerminalTimezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "hosRuleset" "HosRuleset" NOT NULL DEFAULT 'US_70_8_PROPERTY',
    "fleetManagerId" TEXT,
    "assignedVehicleId" TEXT,
    "allowPersonalConveyance" BOOLEAN NOT NULL DEFAULT false,
    "allowYardMove" BOOLEAN NOT NULL DEFAULT false,
    "adverseDrivingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "shortHaulException" BOOLEAN NOT NULL DEFAULT false,
    "splitSleeperEnabled" BOOLEAN NOT NULL DEFAULT false,
    "eldExempt" BOOLEAN NOT NULL DEFAULT false,
    "eldExemptReason" TEXT,
    "appVersion" TEXT,
    "appPlatform" TEXT,
    "sdkVersion" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoDriverPairing" (
    "id" TEXT NOT NULL,
    "primaryDriverId" TEXT NOT NULL,
    "coDriverId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "startedById" TEXT,
    "endedById" TEXT,

    CONSTRAINT "CoDriverPairing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushToken" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "AppPlatform" NOT NULL,
    "deviceLabel" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "unitNumber" TEXT NOT NULL,
    "vin" TEXT NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "licensePlate" TEXT,
    "plateState" TEXT,
    "fuelType" "FuelType" NOT NULL DEFAULT 'DIESEL',
    "sleeperBerth" BOOLEAN NOT NULL DEFAULT false,
    "odometerMi" INTEGER NOT NULL DEFAULT 0,
    "deviceOdometerMi" INTEGER,
    "odometerOffsetMi" INTEGER NOT NULL DEFAULT 0,
    "odometerCalibratedAt" TIMESTAMP(3),
    "engineHours" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "busType" "BusType",
    "status" "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trailer" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "vin" TEXT,
    "status" "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "Trailer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "bleMacAddress" TEXT,
    "model" "DeviceModel" NOT NULL,
    "firmware" TEXT,
    "vehicleId" TEXT,
    "status" "DeviceStatus" NOT NULL DEFAULT 'UNASSIGNED',
    "bleState" "BleState" NOT NULL DEFAULT 'DISCONNECTED',
    "lastSeenAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "storedEventsCount" INTEGER NOT NULL DEFAULT 0,
    "periodicConnectedSec" INTEGER NOT NULL DEFAULT 30,
    "periodicDisconnectedMin" INTEGER NOT NULL DEFAULT 30,
    "pairedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EldEvent" (
    "id" BIGSERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "driverId" TEXT,
    "vehicleId" TEXT,
    "deviceId" TEXT,
    "eventType" INTEGER NOT NULL,
    "eventCode" INTEGER NOT NULL,
    "eventSequenceId" INTEGER NOT NULL,
    "eventDateTime" TIMESTAMP(3) NOT NULL,
    "timezoneOffset" INTEGER NOT NULL,
    "recordStatus" INTEGER NOT NULL DEFAULT 1,
    "recordOrigin" INTEGER NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "locationPrecisionMi" INTEGER NOT NULL DEFAULT 1,
    "locationName" TEXT,
    "locationSource" INTEGER,
    "distanceSinceLastValidCoords" INTEGER,
    "totalVehicleMiles" INTEGER,
    "rawDeviceOdometerKm" INTEGER,
    "totalEngineHours" DECIMAL(10,2),
    "malfunctionCode" TEXT,
    "diagnosticCode" TEXT,
    "annotation" VARCHAR(60),
    "comment" TEXT,
    "supersedesId" BIGINT,
    "editedById" TEXT,
    "editorType" "EditorType",
    "editReason" TEXT,
    "wasStoredOnDevice" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedByDriverId" TEXT,
    "checksum" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EldEvent_pkey" PRIMARY KEY ("id","eventDateTime")
) PARTITION BY RANGE ("eventDateTime");

-- CreateTable
CREATE TABLE "TelemetryPoint" (
    "time" TIMESTAMP(3) NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "speedMph" INTEGER,
    "headingDeg" INTEGER,
    "odometerMi" INTEGER,
    "engineHours" DECIMAL(10,2),
    "idleHours" DECIMAL(10,2),
    "ptoHours" DECIMAL(10,2),
    "engineOn" BOOLEAN,
    "rpm" INTEGER,
    "gear" TEXT,
    "seatBelt" BOOLEAN,
    "loadPct" INTEGER,
    "fuelPct" INTEGER,
    "fuelPct2" INTEGER,
    "defPct" INTEGER,
    "fuelRateGph" DECIMAL(6,2),
    "fuelEconomyMpg" DECIMAL(5,2),
    "totalFuelUsedGal" DECIMAL(10,2),
    "totalFuelIdleGal" DECIMAL(10,2),
    "oilPressurePsi" DECIMAL(6,1),
    "oilPct" INTEGER,
    "oilTempC" INTEGER,
    "coolantPct" INTEGER,
    "coolantTempC" INTEGER,
    "intakeTempC" INTEGER,
    "ambientTempC" INTEGER,
    "transmOilTempC" INTEGER,
    "dtcCount" INTEGER,
    "busType" "BusType",
    "voltage" DECIMAL(4,1),

    CONSTRAINT "TelemetryPoint_pkey" PRIMARY KEY ("time","vehicleId")
) PARTITION BY RANGE ("time");

-- CreateTable
CREATE TABLE "DiagnosticTroubleCode" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "spn" INTEGER,
    "fmi" INTEGER,
    "occurrence" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT,
    "description" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "clearedAt" TIMESTAMP(3),

    CONSTRAINT "DiagnosticTroubleCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyLog" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "logDate" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "offDutySec" INTEGER NOT NULL DEFAULT 0,
    "sleeperSec" INTEGER NOT NULL DEFAULT 0,
    "drivingSec" INTEGER NOT NULL DEFAULT 0,
    "onDutySec" INTEGER NOT NULL DEFAULT 0,
    "totalDistanceMi" INTEGER NOT NULL DEFAULT 0,
    "certified" BOOLEAN NOT NULL DEFAULT false,
    "certifiedAt" TIMESTAMP(3),
    "certifiedById" TEXT,
    "certifierType" "EditorType",
    "certificationCount" INTEGER NOT NULL DEFAULT 0,
    "signatureUrl" TEXT,
    "hasViolation" BOOLEAN NOT NULL DEFAULT false,
    "violationCount" INTEGER NOT NULL DEFAULT 0,
    "hasUnassigned" BOOLEAN NOT NULL DEFAULT false,
    "hasEdits" BOOLEAN NOT NULL DEFAULT false,
    "recalcVersion" INTEGER NOT NULL DEFAULT 1,
    "recalculatedAt" TIMESTAMP(3),

    CONSTRAINT "DailyLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HosViolation" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "dailyLogId" TEXT,
    "logDate" DATE NOT NULL,
    "type" "ViolationType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "exceededBySec" INTEGER NOT NULL,
    "detail" TEXT NOT NULL,
    "status" "ViolationStatus" NOT NULL DEFAULT 'OPEN',
    "recalcVersion" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,

    CONSTRAINT "HosViolation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnidentifiedSegment" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "distanceMi" INTEGER NOT NULL,
    "startLocation" TEXT,
    "endLocation" TEXT,
    "status" "UnidentifiedStatus" NOT NULL DEFAULT 'PENDING',
    "assignedDriverId" TEXT,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3),
    "annotation" VARCHAR(60),
    "eventIds" BIGINT[],
    "fromStoredEvents" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "UnidentifiedSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dvir" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "trailerId" TEXT,
    "type" "DvirType" NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "odometerMi" INTEGER NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "locationName" TEXT,
    "vehicleCondition" "DvirCondition" NOT NULL,
    "driverSignatureUrl" TEXT NOT NULL,
    "notes" VARCHAR(500),
    "mechanicName" TEXT,
    "mechanicSignedAt" TIMESTAMP(3),
    "mechanicNote" TEXT,
    "repairStatus" "RepairStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "nextDriverReviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dvir_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Defect" (
    "id" TEXT NOT NULL,
    "dvirId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "part" "DefectPart" NOT NULL,
    "severity" "DefectSeverity" NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "status" "DefectStatus" NOT NULL DEFAULT 'OPEN',
    "outOfService" BOOLEAN NOT NULL DEFAULT false,
    "workOrderId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Defect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" "WorkOrderPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'OPEN',
    "vendor" TEXT,
    "costUsd" DECIMAL(10,2),
    "odometerMi" INTEGER,
    "openedById" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceSchedule" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "intervalMi" INTEGER,
    "intervalDays" INTEGER,
    "lastServiceMi" INTEGER,
    "lastServiceAt" TIMESTAMP(3),
    "nextDueMi" INTEGER,
    "nextDueAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "MaintenanceSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "driverId" TEXT,
    "vehicleId" TEXT,
    "trailerId" TEXT,
    "status" "TripStatus" NOT NULL DEFAULT 'PLANNED',
    "shippingDocument" TEXT,
    "commodity" TEXT,
    "weightLbs" INTEGER,
    "pieces" INTEGER,
    "plannedStartAt" TIMESTAMP(3),
    "plannedEndAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "etaAt" TIMESTAMP(3),
    "onTime" BOOLEAN,
    "notes" VARCHAR(500),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripStop" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" "StopType" NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "scheduledAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "departedAt" TIMESTAMP(3),
    "status" "StopStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,

    CONSTRAINT "TripStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Geofence" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "GeofenceType" NOT NULL DEFAULT 'CIRCLE',
    "centerLat" DECIMAL(9,6),
    "centerLon" DECIMAL(9,6),
    "radiusMi" DECIMAL(6,2),
    "polygon" JSONB,
    "category" TEXT,
    "alertOnEnter" BOOLEAN NOT NULL DEFAULT false,
    "alertOnExit" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Geofence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyEvent" (
    "id" TEXT NOT NULL,
    "driverId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "type" "SafetyEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "severity" INTEGER NOT NULL,
    "speedMph" INTEGER,
    "speedLimitMph" INTEGER,
    "gForce" DECIMAL(4,2),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "locationName" TEXT,
    "durationSec" INTEGER,
    "status" "CoachingStatus" NOT NULL DEFAULT 'NEW',
    "coachedById" TEXT,
    "coachedAt" TIMESTAMP(3),
    "coachingNote" TEXT,

    CONSTRAINT "SafetyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverScore" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "score" INTEGER NOT NULL,
    "harshCount" INTEGER NOT NULL DEFAULT 0,
    "speedingCount" INTEGER NOT NULL DEFAULT 0,
    "milesDriven" INTEGER NOT NULL DEFAULT 0,
    "violationCount" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER,

    CONSTRAINT "DriverScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "type" "ConversationType" NOT NULL DEFAULT 'DIRECT',
    "title" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationParticipant" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT,
    "driverId" TEXT,
    "lastReadAt" TIMESTAMP(3),
    "mutedUntil" TIMESTAMP(3),

    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderUserId" TEXT,
    "senderDriverId" TEXT,
    "body" VARCHAR(2000) NOT NULL,
    "attachmentId" TEXT,
    "clientId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "conditions" JSONB NOT NULL,
    "channels" TEXT[],
    "recipients" JSONB NOT NULL,
    "throttle" JSONB,
    "quietHours" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertDelivery" (
    "id" TEXT NOT NULL,
    "alertRuleId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "driverId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "objectType" TEXT,
    "objectId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "type" "ReportType" NOT NULL,
    "format" "ReportFormat" NOT NULL,
    "params" JSONB NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'QUEUED',
    "fileKey" TEXT,
    "fileSizeBytes" INTEGER,
    "rowCount" INTEGER,
    "error" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL,
    "reportType" "ReportType" NOT NULL,
    "format" "ReportFormat" NOT NULL,
    "params" JSONB NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "recipients" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataTransfer" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "method" "TransferMethod" NOT NULL,
    "rangeStart" DATE NOT NULL,
    "rangeEnd" DATE NOT NULL,
    "outputFileComment" VARCHAR(60) NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "status" "TransferStatus" NOT NULL DEFAULT 'QUEUED',
    "erodsMode" "ErodsMode" NOT NULL,
    "referenceId" TEXT,
    "responseCode" TEXT,
    "responseBody" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requestedById" TEXT,
    "requestedByType" "EditorType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "DataTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IftaSegment" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT,
    "jurisdiction" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "distanceMi" INTEGER NOT NULL,
    "tollMi" INTEGER NOT NULL DEFAULT 0,
    "fuelGal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IftaSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuelPurchase" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT,
    "purchasedAt" TIMESTAMP(3) NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "gallons" DECIMAL(8,2) NOT NULL,
    "pricePerGal" DECIMAL(6,3) NOT NULL,
    "totalUsd" DECIMAL(10,2) NOT NULL,
    "vendor" TEXT,
    "receiptId" TEXT,
    "source" TEXT,
    "externalId" TEXT,
    "odometerMi" INTEGER,

    CONSTRAINT "FuelPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdById" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT,
    "url" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "httpStatus" INTEGER,
    "responseBody" TEXT,
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "dvirId" TEXT,
    "defectId" TEXT,
    "messageId" TEXT,
    "fuelPurchaseId" TEXT,
    "uploadedById" TEXT,
    "uploadedByType" "EditorType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT,
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "createdByUserId" TEXT,
    "createdByDriverId" TEXT,
    "assignedToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "driverId" TEXT,
    "userId" TEXT,
    "answers" JSONB NOT NULL,
    "comment" VARCHAR(1000),
    "appVersion" TEXT,
    "platform" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverHosSnapshot" (
    "driverId" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hosEngineVersion" TEXT NOT NULL,
    "appPlatform" "AppPlatform",
    "state" JSONB NOT NULL,
    "lastComparedAt" TIMESTAMP(3),
    "maxDriftSec" INTEGER,
    "driftAlerted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DriverHosSnapshot_pkey" PRIMARY KEY ("driverId")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorType" "EditorType" NOT NULL,
    "action" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "detail" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleUid_key" ON "User"("googleUid");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "DriverSession_driverId_revokedAt_idx" ON "DriverSession"("driverId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_username_key" ON "Driver"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_assignedVehicleId_key" ON "Driver"("assignedVehicleId");

-- CreateIndex
CREATE INDEX "Driver_status_idx" ON "Driver"("status");

-- CreateIndex
CREATE INDEX "CoDriverPairing_primaryDriverId_startedAt_idx" ON "CoDriverPairing"("primaryDriverId", "startedAt");

-- CreateIndex
CREATE INDEX "CoDriverPairing_coDriverId_startedAt_idx" ON "CoDriverPairing"("coDriverId", "startedAt");

-- CreateIndex
CREATE INDEX "CoDriverPairing_vehicleId_startedAt_idx" ON "CoDriverPairing"("vehicleId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushToken_token_key" ON "PushToken"("token");

-- CreateIndex
CREATE INDEX "PushToken_driverId_idx" ON "PushToken"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_unitNumber_key" ON "Vehicle"("unitNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_vin_key" ON "Vehicle"("vin");

-- CreateIndex
CREATE INDEX "Vehicle_status_idx" ON "Vehicle"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Trailer_number_key" ON "Trailer"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Device_serial_key" ON "Device"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "Device_bleMacAddress_key" ON "Device"("bleMacAddress");

-- CreateIndex
CREATE INDEX "Device_status_idx" ON "Device"("status");

-- CreateIndex
CREATE INDEX "Device_bleState_lastSeenAt_idx" ON "Device"("bleState", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "Device_vehicleId_key" ON "Device"("vehicleId");

-- CreateIndex
CREATE INDEX "EldEvent_driverId_eventDateTime_idx" ON "EldEvent"("driverId", "eventDateTime");

-- CreateIndex
CREATE INDEX "EldEvent_vehicleId_eventDateTime_idx" ON "EldEvent"("vehicleId", "eventDateTime");

-- CreateIndex
CREATE INDEX "EldEvent_recordStatus_eventDateTime_idx" ON "EldEvent"("recordStatus", "eventDateTime");

-- CreateIndex
CREATE UNIQUE INDEX "EldEvent_uuid_eventDateTime_key" ON "EldEvent"("uuid", "eventDateTime");

-- CreateIndex
CREATE UNIQUE INDEX "EldEvent_driverId_eventSequenceId_eventDateTime_key" ON "EldEvent"("driverId", "eventSequenceId", "eventDateTime");

-- CreateIndex
CREATE INDEX "TelemetryPoint_vehicleId_time_idx" ON "TelemetryPoint"("vehicleId", "time");

-- CreateIndex
CREATE INDEX "DiagnosticTroubleCode_vehicleId_clearedAt_idx" ON "DiagnosticTroubleCode"("vehicleId", "clearedAt");

-- CreateIndex
CREATE INDEX "DailyLog_logDate_idx" ON "DailyLog"("logDate");

-- CreateIndex
CREATE INDEX "DailyLog_certified_logDate_idx" ON "DailyLog"("certified", "logDate");

-- CreateIndex
CREATE UNIQUE INDEX "DailyLog_driverId_logDate_key" ON "DailyLog"("driverId", "logDate");

-- CreateIndex
CREATE INDEX "HosViolation_status_occurredAt_idx" ON "HosViolation"("status", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "HosViolation_driverId_logDate_type_key" ON "HosViolation"("driverId", "logDate", "type");

-- CreateIndex
CREATE INDEX "UnidentifiedSegment_status_startAt_idx" ON "UnidentifiedSegment"("status", "startAt");

-- CreateIndex
CREATE INDEX "UnidentifiedSegment_vehicleId_startAt_idx" ON "UnidentifiedSegment"("vehicleId", "startAt");

-- CreateIndex
CREATE INDEX "Dvir_vehicleId_submittedAt_idx" ON "Dvir"("vehicleId", "submittedAt");

-- CreateIndex
CREATE INDEX "Dvir_driverId_submittedAt_idx" ON "Dvir"("driverId", "submittedAt");

-- CreateIndex
CREATE INDEX "Dvir_repairStatus_idx" ON "Dvir"("repairStatus");

-- CreateIndex
CREATE INDEX "Defect_vehicleId_status_idx" ON "Defect"("vehicleId", "status");

-- CreateIndex
CREATE INDEX "Defect_status_severity_idx" ON "Defect"("status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_number_key" ON "WorkOrder"("number");

-- CreateIndex
CREATE INDEX "WorkOrder_status_dueAt_idx" ON "WorkOrder"("status", "dueAt");

-- CreateIndex
CREATE INDEX "WorkOrder_vehicleId_status_idx" ON "WorkOrder"("vehicleId", "status");

-- CreateIndex
CREATE INDEX "MaintenanceSchedule_vehicleId_enabled_idx" ON "MaintenanceSchedule"("vehicleId", "enabled");

-- CreateIndex
CREATE INDEX "MaintenanceSchedule_nextDueAt_idx" ON "MaintenanceSchedule"("nextDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Trip_number_key" ON "Trip"("number");

-- CreateIndex
CREATE INDEX "Trip_status_plannedStartAt_idx" ON "Trip"("status", "plannedStartAt");

-- CreateIndex
CREATE INDEX "Trip_driverId_status_idx" ON "Trip"("driverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TripStop_tripId_sequence_key" ON "TripStop"("tripId", "sequence");

-- CreateIndex
CREATE INDEX "SafetyEvent_driverId_occurredAt_idx" ON "SafetyEvent"("driverId", "occurredAt");

-- CreateIndex
CREATE INDEX "SafetyEvent_vehicleId_occurredAt_idx" ON "SafetyEvent"("vehicleId", "occurredAt");

-- CreateIndex
CREATE INDEX "SafetyEvent_status_occurredAt_idx" ON "SafetyEvent"("status", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "DriverScore_driverId_periodStart_key" ON "DriverScore"("driverId", "periodStart");

-- CreateIndex
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationParticipant_conversationId_userId_driverId_key" ON "ConversationParticipant"("conversationId", "userId", "driverId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_clientId_key" ON "Message"("clientId");

-- CreateIndex
CREATE INDEX "Message_conversationId_sentAt_idx" ON "Message"("conversationId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlertRule_key_key" ON "AlertRule"("key");

-- CreateIndex
CREATE INDEX "AlertDelivery_status_createdAt_idx" ON "AlertDelivery"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AlertDelivery_subjectType_subjectId_idx" ON "AlertDelivery"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_driverId_readAt_idx" ON "Notification"("driverId", "readAt");

-- CreateIndex
CREATE INDEX "Report_requestedById_requestedAt_idx" ON "Report"("requestedById", "requestedAt");

-- CreateIndex
CREATE INDEX "Report_status_idx" ON "Report"("status");

-- CreateIndex
CREATE INDEX "DataTransfer_driverId_createdAt_idx" ON "DataTransfer"("driverId", "createdAt");

-- CreateIndex
CREATE INDEX "DataTransfer_status_idx" ON "DataTransfer"("status");

-- CreateIndex
CREATE INDEX "IftaSegment_date_idx" ON "IftaSegment"("date");

-- CreateIndex
CREATE UNIQUE INDEX "IftaSegment_vehicleId_jurisdiction_date_key" ON "IftaSegment"("vehicleId", "jurisdiction", "date");

-- CreateIndex
CREATE UNIQUE INDEX "FuelPurchase_externalId_key" ON "FuelPurchase"("externalId");

-- CreateIndex
CREATE INDEX "FuelPurchase_vehicleId_purchasedAt_idx" ON "FuelPurchase"("vehicleId", "purchasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_provider_key" ON "Integration"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextRetryAt_idx" ON "WebhookDelivery"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_key_key" ON "Attachment"("key");

-- CreateIndex
CREATE INDEX "Attachment_dvirId_idx" ON "Attachment"("dvirId");

-- CreateIndex
CREATE INDEX "Attachment_defectId_idx" ON "Attachment"("defectId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_number_key" ON "SupportTicket"("number");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_objectType_objectId_idx" ON "AuditLog"("objectType", "objectId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverSession" ADD CONSTRAINT "DriverSession_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_fleetManagerId_fkey" FOREIGN KEY ("fleetManagerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_assignedVehicleId_fkey" FOREIGN KEY ("assignedVehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoDriverPairing" ADD CONSTRAINT "CoDriverPairing_primaryDriverId_fkey" FOREIGN KEY ("primaryDriverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoDriverPairing" ADD CONSTRAINT "CoDriverPairing_coDriverId_fkey" FOREIGN KEY ("coDriverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoDriverPairing" ADD CONSTRAINT "CoDriverPairing_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushToken" ADD CONSTRAINT "PushToken_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EldEvent" ADD CONSTRAINT "EldEvent_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EldEvent" ADD CONSTRAINT "EldEvent_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EldEvent" ADD CONSTRAINT "EldEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyLog" ADD CONSTRAINT "DailyLog_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HosViolation" ADD CONSTRAINT "HosViolation_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HosViolation" ADD CONSTRAINT "HosViolation_dailyLogId_fkey" FOREIGN KEY ("dailyLogId") REFERENCES "DailyLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dvir" ADD CONSTRAINT "Dvir_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dvir" ADD CONSTRAINT "Dvir_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dvir" ADD CONSTRAINT "Dvir_trailerId_fkey" FOREIGN KEY ("trailerId") REFERENCES "Trailer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_dvirId_fkey" FOREIGN KEY ("dvirId") REFERENCES "Dvir"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceSchedule" ADD CONSTRAINT "MaintenanceSchedule_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripStop" ADD CONSTRAINT "TripStop_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertDelivery" ADD CONSTRAINT "AlertDelivery_alertRuleId_fkey" FOREIGN KEY ("alertRuleId") REFERENCES "AlertRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_dvirId_fkey" FOREIGN KEY ("dvirId") REFERENCES "Dvir"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_defectId_fkey" FOREIGN KEY ("defectId") REFERENCES "Defect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverHosSnapshot" ADD CONSTRAINT "DriverHosSnapshot_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Carrier singleton + eRODS Appendix A constraints (tz.md §5.1)
-- ============================================================================

ALTER TABLE "Carrier" ADD CONSTRAINT carrier_singleton CHECK (id = 'carrier');
ALTER TABLE "Carrier" ADD CONSTRAINT eld_identifier_len CHECK (char_length("eldIdentifier") = 4);

-- ============================================================================
-- Monthly partitioning (tz.md §5.5 EldEvent, §5.6 TelemetryPoint)
--
-- `EldEvent` and `TelemetryPoint` were created above as PARTITION BY RANGE
-- parents. `create_monthly_partition()` is the reusable mechanism the
-- `retention.processor` background job (owned by another agent) calls ahead
-- of need to keep partitions available for future months; it is also used
-- right here to seed the partitions required today so the dev DB is usable
-- immediately after migrate.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_monthly_partition(parent_table text, month_start date)
RETURNS void AS $$
DECLARE
  partition_name text := parent_table || '_y' || to_char(month_start, 'YYYY') || 'm' || to_char(month_start, 'MM');
  range_start date := date_trunc('month', month_start)::date;
  range_end   date := (date_trunc('month', month_start) + interval '1 month')::date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      partition_name, parent_table, range_start, range_end
    );
  END IF;
END;
$$ LANGUAGE plpgsql;

-- EldEvent: FMCSA RODS needs 6 months hot minimum (tz.md §5.5 table). Seed
-- 1 month back .. 7 months forward so retention.processor's monthly cron
-- always finds the *next* month already in place before it is needed.
DO $$
DECLARE m date;
BEGIN
  FOR m IN SELECT generate_series(
      date_trunc('month', now()) - interval '1 month',
      date_trunc('month', now()) + interval '7 months',
      interval '1 month'
    )::date
  LOOP
    PERFORM create_monthly_partition('EldEvent', m);
  END LOOP;
END $$;

-- Safety-net default partition: if retention.processor ever falls behind and
-- an event lands outside all seeded ranges, it is captured here (monitored,
-- tz.md §22.5 alert on ingest lag) instead of the whole INSERT failing.
CREATE TABLE "EldEvent_default" PARTITION OF "EldEvent" DEFAULT;

-- TelemetryPoint: dropped after 13 months (tz.md §5.6) — only near-term
-- partitions are needed. Seed 1 month back .. 2 months forward.
DO $$
DECLARE m date;
BEGIN
  FOR m IN SELECT generate_series(
      date_trunc('month', now()) - interval '1 month',
      date_trunc('month', now()) + interval '2 months',
      interval '1 month'
    )::date
  LOOP
    PERFORM create_monthly_partition('TelemetryPoint', m);
  END LOOP;
END $$;

CREATE TABLE "TelemetryPoint_default" PARTITION OF "TelemetryPoint" DEFAULT;

-- ============================================================================
-- Append-only enforcement at the DB level (tz.md §5.5, §18, §23)
--
-- `EldEvent` and `AuditLog` are never UPDATEd or DELETEd, by anyone,
-- including the application role that owns them (verified: table ownership
-- does NOT bypass REVOKE for ordinary DML privileges in Postgres). No code
-- path — application or migration — may re-GRANT these back.
-- ============================================================================

REVOKE UPDATE, DELETE ON "EldEvent" FROM eld_dev;
REVOKE UPDATE, DELETE ON "AuditLog" FROM eld_dev;
