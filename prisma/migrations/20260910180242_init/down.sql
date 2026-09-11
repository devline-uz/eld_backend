-- DOWN migration for 20260910180242_init (tasks.md Global gate: "every migration
-- tested up and down on the dev DB"; runner: scripts/migrate-updown-dev.sh).
--
-- Reverting the initial migration means returning the database to an empty `public`
-- schema: every table (partitioned parents drop their child partitions via CASCADE),
-- every enum type and the partition-helper function created by migration.sql.
-- `DROP SCHEMA public CASCADE` is deliberately NOT used — it would also drop the
-- schema's own owner/ACL and re-create it with different defaults, which would show
-- up as a false "down did not restore the previous state" diff in the runner.
--
-- Object-level REVOKEs (EldEvent / AuditLog) need no undo: dropping the table drops
-- its ACL with it.

-- 1) Tables (CASCADE also removes indexes, FKs, CHECK constraints and partitions)
DROP TABLE IF EXISTS
  "Carrier",
  "User",
  "Role",
  "Session",
  "DriverSession",
  "Driver",
  "CoDriverPairing",
  "PushToken",
  "Vehicle",
  "Trailer",
  "Device",
  "EldEvent",
  "TelemetryPoint",
  "DiagnosticTroubleCode",
  "DailyLog",
  "HosViolation",
  "UnidentifiedSegment",
  "Dvir",
  "Defect",
  "WorkOrder",
  "MaintenanceSchedule",
  "Trip",
  "TripStop",
  "Geofence",
  "SafetyEvent",
  "DriverScore",
  "Conversation",
  "ConversationParticipant",
  "Message",
  "AlertRule",
  "AlertDelivery",
  "Notification",
  "Report",
  "ReportSchedule",
  "DataTransfer",
  "IftaSegment",
  "FuelPurchase",
  "Integration",
  "ApiKey",
  "WebhookDelivery",
  "Attachment",
  "SupportTicket",
  "Feedback",
  "DriverHosSnapshot",
  "AuditLog",
  "EldEvent_default",
  "TelemetryPoint_default"
  CASCADE;

-- 2) Enum types
DROP TYPE IF EXISTS
  "HosRuleset",
  "DistanceUnit",
  "ErodsMode",
  "AuthProvider",
  "UserStatus",
  "DriverStatus",
  "VehicleStatus",
  "DeviceStatus",
  "DeviceModel",
  "BleState",
  "BusType",
  "FuelType",
  "AppPlatform",
  "EditorType",
  "DutyStatus",
  "ViolationType",
  "ViolationStatus",
  "UnidentifiedStatus",
  "DvirType",
  "DvirCondition",
  "RepairStatus",
  "DefectPart",
  "DefectSeverity",
  "DefectStatus",
  "WorkOrderPriority",
  "WorkOrderStatus",
  "TripStatus",
  "StopType",
  "StopStatus",
  "GeofenceType",
  "SafetyEventType",
  "CoachingStatus",
  "ConversationType",
  "AlertSeverity",
  "DeliveryStatus",
  "ReportType",
  "ReportFormat",
  "ReportStatus",
  "TransferMethod",
  "TransferStatus",
  "IntegrationStatus",
  "TicketPriority",
  "TicketStatus";

-- 3) Partition helper (re-created by a later migration, so drop the exact signature)
DROP FUNCTION IF EXISTS create_monthly_partition(text, date);
