-- Phase 3 (Ingest) — tz.md §5.5, §7.3 rule 5/8, §7.8.
--
-- Three things land here:
--
--  1) `EldEvent.timeDriftSec` — §7.3 rule 5 requires the measured device-clock drift to be
--     PERSISTED with the event (not just turned into a malfunction `T`), so an auditor can see
--     how far off the device clock was on any given record.
--
--  2) `EventSequenceCounter` — §5.5 "Event Sequence ID Number": 1..65535 per driver, monotonic,
--     wrapping to 1 after 65535, assigned ONCE at ingest under a Postgres advisory lock.
--     A counter table is used instead of `MAX("eventSequenceId")` because (a) the value wraps,
--     so MAX is not the previous value, and (b) `EldEvent` is partitioned and append-only —
--     a per-driver MAX would scan every partition forever.
--
--  3) B-009 FIX — `EldEvent`'s three FKs move from `ON DELETE SET NULL` to `ON DELETE NO ACTION`.
--     SET NULL makes Postgres execute `UPDATE "EldEvent" SET "driverId" = NULL ...` from its
--     internal RI trigger, and UPDATE on `EldEvent` is revoked from PUBLIC and from every app
--     role by the append-only hardening (§5.5, §18, §23) — so ANY hard DELETE of a
--     Driver/Vehicle/Device failed with "permission denied for table EldEvent", even for the
--     superuser. NO ACTION removes that hidden UPDATE entirely: a row that §395 events point at
--     simply cannot be hard-deleted (the DELETE is rejected by the FK, loudly, at the right
--     table), and rows with no events delete normally. The application-level rule is unchanged
--     and now enforced by the database rather than only by convention: drivers, vehicles and
--     devices are RETIRED/soft-deleted, never removed.

-- 1) drift column (ALTER on the partitioned parent cascades to every child partition)
ALTER TABLE "EldEvent" ADD COLUMN "timeDriftSec" INTEGER;

-- 2) sequence counter
CREATE TABLE "EventSequenceCounter" (
    "key" TEXT NOT NULL,
    "lastSequenceId" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventSequenceCounter_pkey" PRIMARY KEY ("key")
);

-- 3) FK actions (B-009)
ALTER TABLE "EldEvent" DROP CONSTRAINT "EldEvent_driverId_fkey";
ALTER TABLE "EldEvent" DROP CONSTRAINT "EldEvent_vehicleId_fkey";
ALTER TABLE "EldEvent" DROP CONSTRAINT "EldEvent_deviceId_fkey";

ALTER TABLE "EldEvent" ADD CONSTRAINT "EldEvent_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "EldEvent" ADD CONSTRAINT "EldEvent_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "EldEvent" ADD CONSTRAINT "EldEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 4) Ingest-time partition provisioning (§5.5 "oylik partition").
--    Events arrive LATE — hours, and per §7.3 rule 3 up to 30 days late — so ingest cannot
--    assume `retention.processor` has already created the month it needs. This wrapper is
--    safe to call on every batch: it is a no-op when the partition exists, and it refuses to
--    fail the INSERT when the partition cannot be created (rows already parked in the DEFAULT
--    partition overlap the range). In that case the row still lands in `EldEvent_default` and
--    nothing is lost.
CREATE OR REPLACE FUNCTION ensure_event_partition(month_start date)
RETURNS boolean AS $$
BEGIN
  PERFORM create_monthly_partition('EldEvent', month_start);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'ensure_event_partition(%) skipped: %', month_start, SQLERRM;
  RETURN false;
END;
$$ LANGUAGE plpgsql;
