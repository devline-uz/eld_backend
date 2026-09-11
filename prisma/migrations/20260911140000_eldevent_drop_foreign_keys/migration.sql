-- B-009 ROOT-CAUSE FIX (tz.md §5.5, §18, §23; bugs.md B-009).
--
-- The previous migration moved `EldEvent`'s three foreign keys from ON DELETE SET NULL to
-- ON DELETE NO ACTION. Verified against Postgres 16: that is NOT enough. Postgres implements
-- both variants with internal RI triggers that need privileges the append-only REVOKE removed:
--
--   SET NULL                  -> UPDATE "EldEvent" SET "deviceId" = NULL WHERE ...   (UPDATE revoked)
--   NO ACTION / RESTRICT      -> SELECT 1 FROM "EldEvent" x WHERE ... FOR KEY SHARE  (row locks
--                                need UPDATE or DELETE privilege — SELECT alone is not enough)
--
-- Result before this migration: deleting ANY Driver/Vehicle/Device failed with
-- `ERROR: permission denied for table EldEvent`, even when the row had no events at all.
--
-- An append-only ledger therefore cannot participate in referential integrity. The three FKs
-- are dropped; `driverId`, `vehicleId` and `deviceId` remain as indexed scalar columns.
-- Integrity moves to the write path, where it belongs for this table: `IngestService` resolves
-- and verifies the device, the unit and the driver (§7 — the payload is untrusted) before a
-- single row is inserted, and `EldEvent` is never updated afterwards.
--
-- This is also the correct §395 semantics: an ELD record keeps the driver/vehicle/device id it
-- was recorded with forever. It must never be nulled or re-pointed as a side effect of a
-- parent-row operation.
--
-- Proven in `test/integration/ingest-storage.spec.ts`: a device WITH events and a device
-- WITHOUT events both hard-delete cleanly, `EldEvent` keeps the historical ids, and UPDATE /
-- DELETE on `EldEvent` are still refused (test/integration/append-only.spec.ts).

ALTER TABLE "EldEvent" DROP CONSTRAINT "EldEvent_driverId_fkey";
ALTER TABLE "EldEvent" DROP CONSTRAINT "EldEvent_vehicleId_fkey";
ALTER TABLE "EldEvent" DROP CONSTRAINT "EldEvent_deviceId_fkey";

-- DOWN (tested on the dev DB inside a rolled-back transaction): re-adding these FKs is only
-- possible while no orphan rows exist. Once a Vehicle/Driver/Device that has events has been
-- hard-deleted, `ADD CONSTRAINT` fails with a FK violation, and `NOT VALID` is not supported on
-- a partitioned table ("cannot add NOT VALID foreign key on partitioned table"). Since
-- `EldEvent` is append-only, the orphans cannot be cleaned either. This migration is therefore
-- effectively irreversible by design — which is the intent: the FKs must not come back.
