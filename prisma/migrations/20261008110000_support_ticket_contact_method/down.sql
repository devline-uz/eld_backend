-- Reverts 20261008110000_support_ticket_contact_method (MR-20).
ALTER TABLE "SupportTicket" DROP COLUMN "contactMethod";

DROP TYPE "SupportContactMethod";
