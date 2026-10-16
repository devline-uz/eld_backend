-- DOWN migration for 20261013100000_message_audio
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- Voice messages lose their type (they read as TEXT rows with an attachment) and duration.
DROP INDEX IF EXISTS "Attachment_messageId_idx";
ALTER TABLE "Attachment" DROP COLUMN IF EXISTS "durationMs";
ALTER TABLE "Message" DROP COLUMN IF EXISTS "type";
DROP TYPE IF EXISTS "MessageType";
