-- MB-13 (backend/tasks.md Phase 6b) — `Notification.kind` is a nullable, mobile-app filter
-- bucket derived from the triggering alert event name (AlertProcessor). Nullable/backfilled
-- because pre-existing rows have no reliable event name to derive from (their `type` is the
-- AlertRule id, not the event) — left null there per the task brief ("backfill where derivable,
-- else leave null"). No historical row carries enough context to derive a kind, so no UPDATE.
CREATE TYPE "NotificationKind" AS ENUM ('VIOLATION', 'WARNING', 'EDIT_REQUEST', 'MESSAGE', 'TRIP', 'UNIDENTIFIED', 'CERTIFY', 'MAINTENANCE', 'DEVICE', 'OTHER');

ALTER TABLE "Notification" ADD COLUMN "kind" "NotificationKind";

-- MB-16 — `GET /mobile/support/tickets` (and the existing web `GET /support/tickets`) need an
-- `updatedAt` to report to the client; `SupportTicket` never tracked one. Backfilled from
-- `createdAt` for existing rows (best available approximation — no better source of truth).
ALTER TABLE "SupportTicket" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "SupportTicket" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "SupportTicket" ALTER COLUMN "updatedAt" SET NOT NULL;
ALTER TABLE "SupportTicket" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
