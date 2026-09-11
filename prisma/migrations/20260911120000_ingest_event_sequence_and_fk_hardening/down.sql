-- DOWN migration for 20260911120000_ingest_event_sequence_and_fk_hardening
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- Reverses, in the opposite order of the UP:
--   4) ensure_event_partition() wrapper            -> dropped
--   3) EldEvent FKs (NO ACTION)                    -> back to ON DELETE SET NULL
--   2) EventSequenceCounter                        -> dropped
--   1) EldEvent."timeDriftSec"                     -> dropped
--
-- ⚠️ Data loss on the way down is intentional and unavoidable: dropping
-- `EventSequenceCounter` discards the per-driver §5.5 sequence cursor and dropping
-- `timeDriftSec` discards the measured device-clock drift recorded with each event.
-- Re-adding the SET NULL foreign keys also re-introduces the B-009 failure mode
-- (Postgres' RI trigger needs UPDATE on the append-only table), which is precisely why
-- the UP exists. Dev/scratch databases only.

DROP FUNCTION IF EXISTS ensure_event_partition(date);

ALTER TABLE "EldEvent" DROP CONSTRAINT IF EXISTS "EldEvent_driverId_fkey";
ALTER TABLE "EldEvent" DROP CONSTRAINT IF EXISTS "EldEvent_vehicleId_fkey";
ALTER TABLE "EldEvent" DROP CONSTRAINT IF EXISTS "EldEvent_deviceId_fkey";

ALTER TABLE "EldEvent" ADD CONSTRAINT "EldEvent_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EldEvent" ADD CONSTRAINT "EldEvent_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EldEvent" ADD CONSTRAINT "EldEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP TABLE IF EXISTS "EventSequenceCounter";

ALTER TABLE "EldEvent" DROP COLUMN IF EXISTS "timeDriftSec";
