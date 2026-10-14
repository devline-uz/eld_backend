-- ELD device serials: one canonical form, unique ignoring case and surrounding spaces (CODE-009).
--
-- The API now stores every serial trimmed + upper-cased (`normalizeDeviceSerial` in
-- src/modules/devices/dto/devices.dto.ts — `POST /devices`, `POST /devices/import`) and looks
-- devices up case-insensitively, the same canonical form the vehicle form already uses
-- (`normalizeUniqueValue` in src/modules/vehicles/lib/vehicle-uniques.ts). Rows written before
-- that may be lower/mixed-case or carry stray spaces.
--
-- Prisma's schema language can't express expression indexes, so "Device_serial_upper_key" exists
-- only here. It is whitelisted in src/core/prisma/custom-indexes.ts. The plain "Device_serial_key"
-- (@unique in schema.prisma) stays as-is.
--
-- Steps:
--   0. Refuse (clear error, nothing changed) if two rows collide once normalised — those need a
--      human decision (which row keeps the ELD events / vehicle pairing); this migration never
--      merges or deletes devices.
--   1. Normalise existing values (trim spaces / tabs / newlines + upper-case).
--   2. Unique index on upper(btrim("serial")).

-- 0. Guard.
DO $$
DECLARE
  collisions integer;
BEGIN
  SELECT count(*) INTO collisions
  FROM (
    SELECT upper(btrim("serial", E' \t\r\n')) AS s
    FROM "Device"
    GROUP BY 1
    HAVING count(*) > 1
  ) dup;
  IF collisions > 0 THEN
    RAISE EXCEPTION 'Device.serial: % serial(s) collide case-insensitively; resolve them before applying 20261014140000_device_serial_upper_unique', collisions;
  END IF;
END $$;

-- 1. Normalise.
UPDATE "Device"
SET "serial" = upper(btrim("serial", E' \t\r\n'))
WHERE "serial" <> upper(btrim("serial", E' \t\r\n'));

-- 2. Expression unique index (NOT representable in schema.prisma).
CREATE UNIQUE INDEX "Device_serial_upper_key" ON "Device" (upper(btrim("serial")));
