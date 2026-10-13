-- Web chat voice messages. Additive only: every existing Message row becomes TEXT by default.
-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'AUDIO');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "type" "MessageType" NOT NULL DEFAULT 'TEXT';

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN "durationMs" INTEGER;

-- CreateIndex
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");
