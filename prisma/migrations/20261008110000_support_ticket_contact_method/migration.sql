-- MR-20 (docs/mobile-requests-2026-10-08.md) — POST /mobile/support/tickets `contactMethod`
-- (EMAIL | PHONE) is now persisted. Additive, nullable: existing rows stay valid.
CREATE TYPE "SupportContactMethod" AS ENUM ('EMAIL', 'PHONE');

ALTER TABLE "SupportTicket" ADD COLUMN "contactMethod" "SupportContactMethod";
