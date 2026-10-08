-- bugs.md B-138 / decisions.md D-121 — §395 Appendix A 7.15: the ELD Identifier is EXACTLY
-- 6 characters of [A-Z0-9] (provider-coded at certification, e.g. 1001ZE). The column was
-- VARCHAR(4) + CHECK ^[A-Z0-9]{4}$, which made every output file non-conformant. The ELD
-- Registration ID (7.17) stays 4 characters and is not touched here.
--
-- Data path for existing 4-char values (D-121):
--   * the old placeholder default 'OBK1'      -> the new placeholder default 'OBK001';
--   * any other 4-char value                  -> right-padded with '00' (prefix kept visible,
--                                                 reversible by the down migration);
--   * anything else that is not 6 x [A-Z0-9]  -> 'OBK001' (cannot occur under the old CHECK).
--   A carrier that was in PRODUCTION with a rewritten (placeholder) identifier is moved back to
--   TEST: a padded value is not the certified identifier, and sending files with it to FMCSA
--   would fail. TEST still generates, stores and serves the file (tz.md §10.1).

ALTER TABLE "Carrier" DROP CONSTRAINT IF EXISTS eld_identifier_format;
ALTER TABLE "Carrier" ALTER COLUMN "eldIdentifier" TYPE VARCHAR(6);

UPDATE "Carrier" SET "erodsMode" = 'TEST'
 WHERE "erodsMode" = 'PRODUCTION' AND "eldIdentifier" !~ '^[A-Z0-9]{6}$';

UPDATE "Carrier" SET "eldIdentifier" = 'OBK001' WHERE "eldIdentifier" = 'OBK1';
UPDATE "Carrier" SET "eldIdentifier" = "eldIdentifier" || '00'
 WHERE "eldIdentifier" ~ '^[A-Z0-9]{4}$';
UPDATE "Carrier" SET "eldIdentifier" = 'OBK001'
 WHERE "eldIdentifier" !~ '^[A-Z0-9]{6}$';

ALTER TABLE "Carrier" ALTER COLUMN "eldIdentifier" SET DEFAULT 'OBK001';
ALTER TABLE "Carrier" ADD CONSTRAINT eld_identifier_format
  CHECK ("eldIdentifier" ~ '^[A-Z0-9]{6}$');
