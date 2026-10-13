-- MB-9 — voice-message length for CHAT_AUDIO attachments. Additive, nullable.
ALTER TABLE "Attachment" ADD COLUMN "durationSec" INTEGER;
