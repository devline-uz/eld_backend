-- Vehicle unit number and license plate: one canonical form for uniqueness (CODE-044).
--
-- The app already treats "#101" / "101" and "t1" / "T1" as the same unit
-- (`VehiclesRepository.findByUnitNumber`), but "Vehicle_unitNumber_live_key" compares the raw
-- value, so a direct write or a race could still store both. License plates were trimmed and
-- upper-cased but kept internal spaces/dashes, so "ABC 123" and "ABC-123" were two plates.
--
-- The API now stores plates without spaces/dashes (`normalizePlate` in
-- src/modules/vehicles/lib/vehicle-uniques.ts). This migration:
--   0. refuses (clear error, nothing changed) when live rows collide once normalised — those
--      need a human decision; it never merges, renames or deletes vehicles;
--   1. normalises existing live plates (upper, no whitespace/dashes; '' -> NULL);
--   2. adds an expression partial unique index on the canonical unit number (upper, trimmed,
--      leading '#' dropped). "Vehicle_unitNumber_live_key" stays as-is.
--
-- "Vehicle_unitNumber_canonical_live_key" exists only here; it is whitelisted in
-- src/core/prisma/custom-indexes.ts.

-- 0. Guards.
DO $$
DECLARE
  unit_collisions integer;
  plate_collisions integer;
BEGIN
  SELECT count(*) INTO unit_collisions
  FROM (
    SELECT upper(ltrim(btrim("unitNumber"), '#'))
    FROM "Vehicle"
    WHERE "deletedAt" IS NULL
    GROUP BY 1
    HAVING count(*) > 1
  ) dup;
  IF unit_collisions > 0 THEN
    RAISE EXCEPTION 'Vehicle.unitNumber: % live unit number(s) collide ignoring case and a leading #; resolve them before applying 20261014200000_vehicle_unit_plate_canonical', unit_collisions;
  END IF;

  SELECT count(*) INTO plate_collisions
  FROM (
    SELECT regexp_replace(upper("licensePlate"), '[[:space:]-]', '', 'g'), COALESCE(upper(btrim("plateState")), '')
    FROM "Vehicle"
    WHERE "deletedAt" IS NULL AND "licensePlate" IS NOT NULL
      AND regexp_replace("licensePlate", '[[:space:]-]', '', 'g') <> ''
    GROUP BY 1, 2
    HAVING count(*) > 1
  ) dup;
  IF plate_collisions > 0 THEN
    RAISE EXCEPTION 'Vehicle.licensePlate: % live plate(s) collide ignoring spaces/dashes in the same state; resolve them before applying 20261014200000_vehicle_unit_plate_canonical', plate_collisions;
  END IF;
END $$;

-- 1. Normalise plates (live and soft-deleted rows alike; a deleted row never blocks a live one).
UPDATE "Vehicle"
SET "licensePlate" = NULLIF(regexp_replace(upper("licensePlate"), '[[:space:]-]', '', 'g'), '')
WHERE "licensePlate" IS NOT NULL
  AND "licensePlate" IS DISTINCT FROM NULLIF(regexp_replace(upper("licensePlate"), '[[:space:]-]', '', 'g'), '');

-- 2. Expression partial unique index (NOT representable in schema.prisma).
CREATE UNIQUE INDEX "Vehicle_unitNumber_canonical_live_key"
  ON "Vehicle" (upper(ltrim(btrim("unitNumber"), '#')))
  WHERE "deletedAt" IS NULL;
