-- Phase 6 (Mobile API) — §13 offline sync idempotency ledger + signature-hash columns.

ALTER TABLE "DailyLog" ADD COLUMN "signatureHash" TEXT;
ALTER TABLE "Dvir" ADD COLUMN "driverSignatureHash" TEXT;
ALTER TABLE "Attachment" ADD COLUMN "sha256" TEXT;

CREATE TYPE "SyncedChangeStatus" AS ENUM ('ACCEPTED', 'REJECTED');

-- §13.4/13.6 — one row per processed `POST /mobile/sync` change; `clientId` is unique so a
-- replayed change (dropped response, duplicate queue entry) is a no-op the second time.
CREATE TABLE "SyncedChange" (
    "id"          TEXT NOT NULL,
    "driverId"    TEXT NOT NULL,
    "clientId"    TEXT NOT NULL,
    "type"        TEXT NOT NULL,
    "status"      "SyncedChangeStatus" NOT NULL,
    "errorCode"   TEXT,
    "result"      JSONB,
    "occurredAt"  TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncedChange_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SyncedChange_clientId_key" ON "SyncedChange"("clientId");
CREATE INDEX "SyncedChange_driverId_processedAt_idx" ON "SyncedChange"("driverId", "processedAt");

ALTER TABLE "SyncedChange" ADD CONSTRAINT "SyncedChange_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
