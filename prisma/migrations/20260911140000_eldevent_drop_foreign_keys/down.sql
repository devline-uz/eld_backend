-- DOWN migration for 20260911140000_eldevent_drop_foreign_keys
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- The UP dropped EldEvent's three foreign keys for good (see migration.sql: an
-- append-only ledger cannot participate in referential integrity — Postgres' RI trigger
-- needs UPDATE / row-lock privileges that the §5.5 REVOKE removes).
--
-- ⚠️ REVERSIBLE ONLY WHILE NO ORPHAN ROWS EXIST. `ADD CONSTRAINT` validates immediately
-- and `NOT VALID` is rejected on a partitioned table ("cannot add NOT VALID foreign key on
-- partitioned table"), so on a populated database where a Driver/Vehicle/Device that had
-- events has since been hard-deleted this file fails by design and the migration is
-- irreversible in practice. The up/down runner proves it on an empty scratch database;
-- nothing may run it against a live database. The FKs must not come back.

ALTER TABLE "EldEvent" ADD CONSTRAINT "EldEvent_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "EldEvent" ADD CONSTRAINT "EldEvent_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "EldEvent" ADD CONSTRAINT "EldEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
