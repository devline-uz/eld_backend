-- Offline records from a replaced device (backend-tasks item 7, decisions.md D-163).
-- A record that device A recorded AFTER device B replaced its session (and before the driver
-- logged in on A again) is stored and never rejected, but flagged for fleet-manager review.
-- Columns are written once at INSERT time only: EldEvent is append-only (UPDATE/DELETE revoked).
-- ADD COLUMN / CREATE INDEX on the partitioned parent propagate to every partition.
ALTER TABLE "EldEvent"
  ADD COLUMN "reviewReason" TEXT,
  ADD COLUMN "reviewDeviceLabel" TEXT;

-- "This driver's flagged records" (GET /logs/:driverId/events?review=REPLACED_DEVICE).
CREATE INDEX "EldEvent_driverId_reviewReason_eventDateTime_idx"
  ON "EldEvent"("driverId", "reviewReason", "eventDateTime");
