-- DOWN migration for 20260911160000_mobile_sync_signature
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- Reverses the §13 offline-sync idempotency ledger and the signature/attachment hash
-- columns, in the opposite order of the UP.
--
-- ⚠️ Data loss on the way down: dropping `SyncedChange` discards the idempotency ledger, so
-- a queued mobile change that was already applied could be replayed and applied twice after
-- a revert. Dropping `signatureHash`/`driverSignatureHash` discards the stored driver
-- signature hashes (the certification and DVIR rows themselves are untouched). Dev only.

DROP TABLE IF EXISTS "SyncedChange";
DROP TYPE IF EXISTS "SyncedChangeStatus";

ALTER TABLE "Attachment" DROP COLUMN IF EXISTS "sha256";
ALTER TABLE "Dvir" DROP COLUMN IF EXISTS "driverSignatureHash";
ALTER TABLE "DailyLog" DROP COLUMN IF EXISTS "signatureHash";
