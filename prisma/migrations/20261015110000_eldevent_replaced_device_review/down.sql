-- Reverts 20261015110000_eldevent_replaced_device_review (D-163).
DROP INDEX IF EXISTS "EldEvent_driverId_reviewReason_eventDateTime_idx";

ALTER TABLE "EldEvent"
  DROP COLUMN IF EXISTS "reviewReason",
  DROP COLUMN IF EXISTS "reviewDeviceLabel";
