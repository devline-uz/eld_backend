-- Revert 20261011150000_attachment_duration_sec.
ALTER TABLE "Attachment" DROP COLUMN IF EXISTS "durationSec";
