-- License plate + issuing state unique among LIVE vehicles (web 11.2 Add vehicle / Edit unit,
-- 409 `LICENSE_PLATE_TAKEN`). Same plate in another state is fine; a unit with no plate never
-- conflicts; soft-deleted units ("deletedAt" IS NOT NULL) give their plate back.
--
-- ELD serial uniqueness needs no new index: the device <-> vehicle link lives only on
-- "Device"."vehicleId", already guarded by "Device_vehicleId_key" (one device per unit) and
-- "Device_serial_key" (one row per serial), so a serial can be paired to at most one unit.
--
-- Prisma's schema language can't express expression/partial indexes, so
-- "Vehicle_plate_state_live_key" exists only here (like the "*_live_key" indexes of
-- 20260927090000_soft_delete_partial_uniques). It is whitelisted in
-- src/core/prisma/custom-indexes.ts: `npm run migrate:dev` strips any DROP/CREATE of it from a
-- generated migration, and custom-indexes.spec.ts fails on a drop without
-- `-- custom-index: drop Vehicle_plate_state_live_key`.
--
-- Steps:
--   1. Normalise existing values the way the API now writes them (trim + upper-case, '' -> NULL),
--      on every row — live or deleted — so lookups and the index see one canonical form.
--   2. De-duplicate live rows NON-destructively: within each (plate, state) group of live units the
--      oldest unit ("createdAt", then "id") keeps the plate; every newer one has "licensePlate"
--      cleared (state is kept) and the cleared value appended to its "notes" so nothing is lost and
--      the fleet manager can re-enter a corrected plate. No row is deleted or soft-deleted.
--   3. Create the partial unique index. The state half is COALESCEd to '' so a plate with no state
--      is unique too (a bare NULL would make every such row distinct under a unique index).

-- 1. Normalise.
UPDATE "Vehicle"
SET "licensePlate" = NULLIF(upper(btrim("licensePlate")), ''),
    "plateState"   = NULLIF(upper(btrim("plateState")), '')
WHERE "licensePlate" IS DISTINCT FROM NULLIF(upper(btrim("licensePlate")), '')
   OR "plateState"   IS DISTINCT FROM NULLIF(upper(btrim("plateState")), '');

-- 2. Non-destructive de-duplication of live rows (oldest keeps the plate).
WITH ranked AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "licensePlate", COALESCE("plateState", '')
           ORDER BY "createdAt", "id"
         ) AS rn
  FROM "Vehicle"
  WHERE "deletedAt" IS NULL AND "licensePlate" IS NOT NULL
)
UPDATE "Vehicle" v
SET "notes" = concat_ws(
      E'\n',
      NULLIF(v."notes", ''),
      format(
        '[2026-10-07 plate de-duplication] License plate "%s"%s was cleared: another unit already holds it. Re-enter the correct plate.',
        v."licensePlate",
        CASE WHEN v."plateState" IS NULL THEN '' ELSE format(' (%s)', v."plateState") END
      )
    ),
    "licensePlate" = NULL
FROM ranked r
WHERE v."id" = r."id" AND r.rn > 1;

-- 3. Partial unique index (live rows with a plate only; NOT representable in schema.prisma).
CREATE UNIQUE INDEX "Vehicle_plate_state_live_key"
  ON "Vehicle" (upper(btrim("licensePlate")), COALESCE(upper(btrim("plateState")), ''))
  WHERE "deletedAt" IS NULL AND "licensePlate" IS NOT NULL AND btrim("licensePlate") <> '';
