-- Reverts 20261014100000_user_pending_email. Any pending email change is lost.
DROP INDEX "User_pendingEmail_idx";

ALTER TABLE "User" DROP COLUMN "emailChangedAt",
DROP COLUMN "pendingEmail",
DROP COLUMN "pendingEmailRequestedAt",
DROP COLUMN "pendingEmailRequestedById",
DROP COLUMN "previousEmail";
