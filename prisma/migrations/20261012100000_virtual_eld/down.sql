-- DOWN migration for 20261012100000_virtual_eld
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- Drops the Virtual ELD (PT Emulator) columns. Reverting while virtual devices exist makes them
-- look like real devices; purge them first.
DROP INDEX IF EXISTS "Device_isVirtual_idx";
ALTER TABLE "Device" DROP COLUMN IF EXISTS "isVirtual";
ALTER TABLE "Carrier" DROP COLUMN IF EXISTS "virtualEldEnabled",
DROP COLUMN IF EXISTS "virtualEldUpdatedAt",
DROP COLUMN IF EXISTS "virtualEldUpdatedById";
