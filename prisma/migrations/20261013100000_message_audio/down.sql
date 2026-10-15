-- Reverts 20261013100000_message_audio. Voice messages keep their row but lose type/duration.
DROP INDEX "Attachment_messageId_idx";

ALTER TABLE "Attachment" DROP COLUMN "durationMs";

ALTER TABLE "Message" DROP COLUMN "type";

DROP TYPE "MessageType";
