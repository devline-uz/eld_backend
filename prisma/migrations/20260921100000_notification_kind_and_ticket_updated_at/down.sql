ALTER TABLE "SupportTicket" DROP COLUMN "updatedAt";
ALTER TABLE "Notification" DROP COLUMN "kind";
DROP TYPE "NotificationKind";
