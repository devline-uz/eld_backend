-- DOWN migration for 20260911150000_erods_identifier_charset
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- Restores the weaker init-era constraint set:
--   eld_identifier_format      -> eld_identifier_len (char_length = 4 only)
--   eld_registration_id_format -> dropped (no check at all)
--
-- NOT reverted (and not revertible): the UP's data normalisation — upper-casing
-- "eldIdentifier"/"eldRegistrationId" and resetting values that could never be valid under
-- Appendix A. The original mixed-case/illegal values are not recorded anywhere, and
-- restoring them would put an invalid ELD Identifier back into the output file. Schema
-- reversal is complete; that one data step is deliberately one-way.

ALTER TABLE "Carrier" DROP CONSTRAINT IF EXISTS eld_registration_id_format;
ALTER TABLE "Carrier" DROP CONSTRAINT IF EXISTS eld_identifier_format;
ALTER TABLE "Carrier" ADD CONSTRAINT eld_identifier_len CHECK (char_length("eldIdentifier") = 4);
