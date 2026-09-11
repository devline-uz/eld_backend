-- §395 Appendix A: ELD Identifier and ELD Registration ID are EXACTLY 4 characters
-- from [A-Z0-9]. The init migration only checked char_length on "eldIdentifier";
-- a 4-char value with an illegal character (e.g. 'ob#1'), and any length of
-- "eldRegistrationId" under 4, could still be persisted and would invalidate the
-- generated output file. Normalise existing data, then enforce the full rule.

UPDATE "Carrier" SET "eldIdentifier" = 'OBK1'
 WHERE "eldIdentifier" !~ '^[A-Z0-9]{4}$' AND upper("eldIdentifier") !~ '^[A-Z0-9]{4}$';
UPDATE "Carrier" SET "eldIdentifier" = upper("eldIdentifier")
 WHERE "eldIdentifier" !~ '^[A-Z0-9]{4}$';
UPDATE "Carrier" SET "eldRegistrationId" = upper("eldRegistrationId")
 WHERE "eldRegistrationId" IS NOT NULL AND "eldRegistrationId" !~ '^[A-Z0-9]{4}$';
UPDATE "Carrier" SET "eldRegistrationId" = NULL
 WHERE "eldRegistrationId" IS NOT NULL AND "eldRegistrationId" !~ '^[A-Z0-9]{4}$';

ALTER TABLE "Carrier" DROP CONSTRAINT IF EXISTS eld_identifier_len;
ALTER TABLE "Carrier" ADD CONSTRAINT eld_identifier_format
  CHECK ("eldIdentifier" ~ '^[A-Z0-9]{4}$');
ALTER TABLE "Carrier" ADD CONSTRAINT eld_registration_id_format
  CHECK ("eldRegistrationId" IS NULL OR "eldRegistrationId" ~ '^[A-Z0-9]{4}$');
