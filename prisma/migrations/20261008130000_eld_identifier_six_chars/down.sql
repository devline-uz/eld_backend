-- DOWN migration for 20261008130000_eld_identifier_six_chars
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- Restores VARCHAR(4) + CHECK ^[A-Z0-9]{4}$ + default 'OBK1'.
-- Data: 'OBK001' -> 'OBK1'; a '00'-padded value -> its original 4 chars; any other 6-char
-- value (entered after the UP) is cut to its first 4 characters so the old CHECK holds.
-- NOT reverted: the PRODUCTION -> TEST mode reset of the UP (which rows were flipped is not
-- recorded; staying in TEST is the safe side).

ALTER TABLE "Carrier" DROP CONSTRAINT IF EXISTS eld_identifier_format;

UPDATE "Carrier" SET "eldIdentifier" = 'OBK1' WHERE "eldIdentifier" = 'OBK001';
UPDATE "Carrier" SET "eldIdentifier" = left("eldIdentifier", 4)
 WHERE char_length("eldIdentifier") <> 4;

ALTER TABLE "Carrier" ALTER COLUMN "eldIdentifier" TYPE VARCHAR(4);
ALTER TABLE "Carrier" ALTER COLUMN "eldIdentifier" SET DEFAULT 'OBK1';
ALTER TABLE "Carrier" ADD CONSTRAINT eld_identifier_format
  CHECK ("eldIdentifier" ~ '^[A-Z0-9]{4}$');
