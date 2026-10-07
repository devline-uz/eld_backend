-- B-100 — driver phone number and licence (CDL) number unique among LIVE drivers
-- ("deletedAt" IS NULL), compared the way the web compares them:
--   phone: digits only, a leading US "1" on an 11-digit number dropped
--          ("+1 (614) 555-1000" = "6145551000");
--   cdlNumber: upper-cased, whitespace and dashes removed ("w 856-9238" = "W8569238").
-- A driver with no phone never conflicts. Values are stored as entered; only the index key is
-- normalised (the API's `driver-uniques.ts` computes the same keys for its pre-checks).
--
-- Both indexes are expression/partial indexes Prisma's schema language can't express. They are
-- whitelisted in src/core/prisma/custom-indexes.ts: `npm run migrate:dev` strips any DROP/CREATE
-- of them from a generated migration, and custom-indexes.spec.ts fails on a drop without
-- `-- custom-index: drop <name>`.
--
-- Steps:
--   1. De-duplicate live phones NON-destructively: within each phone key the oldest live driver
--      ("registeredAt", then "id") keeps the number; every newer one has "phone" cleared. Each
--      cleared value is recorded first as an append-only "AuditLog" row (actorType SYSTEM,
--      action DRIVER_PHONE_DEDUPLICATED, before/after JSON) so it shows in the driver's history
--      and can be restored. No driver row is deleted or soft-deleted.
--   2. Same for licence numbers, except "cdlNumber" is NOT NULL: the newer duplicates get a
--      "DUP-<first 8 chars of id>-" prefix (unique by construction) instead of NULL, audited the
--      same way, so the fleet manager can correct them. (Local dev DB had 0 CDL duplicates.)
--   3. Create the two partial unique indexes.

-- 1. Phone de-duplication.
CREATE TEMP TABLE "_driver_phone_dups" AS
SELECT "id", "phone"
FROM (
  SELECT "id", "phone",
         row_number() OVER (PARTITION BY k ORDER BY "registeredAt", "id") AS rn
  FROM (
    SELECT "id", "phone", "registeredAt",
           CASE WHEN length(d) = 11 AND left(d, 1) = '1' THEN substr(d, 2) ELSE d END AS k
    FROM (
      SELECT "id", "phone", "registeredAt", regexp_replace(coalesce("phone", ''), '\D', '', 'g') AS d
      FROM "Driver"
      WHERE "deletedAt" IS NULL
    ) digits
  ) keyed
  WHERE k <> ''
) ranked
WHERE rn > 1;

INSERT INTO "AuditLog" ("actorId", "actorType", "action", "objectType", "objectId", "before", "after", "detail")
SELECT 'migration:20261007100000_driver_phone_cdl_live_unique', 'SYSTEM', 'DRIVER_PHONE_DEDUPLICATED', 'Driver', "id",
       jsonb_build_object('phone', "phone"), jsonb_build_object('phone', NULL),
       'Phone number cleared: another live driver already has it (B-100 unique phone). Re-enter the correct number.'
FROM "_driver_phone_dups";

UPDATE "Driver" d SET "phone" = NULL FROM "_driver_phone_dups" x WHERE d."id" = x."id";
DROP TABLE "_driver_phone_dups";

-- 2. Licence-number de-duplication.
CREATE TEMP TABLE "_driver_cdl_dups" AS
SELECT "id", "cdlNumber"
FROM (
  SELECT "id", "cdlNumber",
         row_number() OVER (
           PARTITION BY upper(regexp_replace("cdlNumber", '[\s-]', '', 'g'))
           ORDER BY "registeredAt", "id"
         ) AS rn
  FROM "Driver"
  WHERE "deletedAt" IS NULL AND regexp_replace("cdlNumber", '[\s-]', '', 'g') <> ''
) ranked
WHERE rn > 1;

INSERT INTO "AuditLog" ("actorId", "actorType", "action", "objectType", "objectId", "before", "after", "detail")
SELECT 'migration:20261007100000_driver_phone_cdl_live_unique', 'SYSTEM', 'DRIVER_CDL_DEDUPLICATED', 'Driver', "id",
       jsonb_build_object('cdlNumber', "cdlNumber"),
       jsonb_build_object('cdlNumber', 'DUP-' || left("id", 8) || '-' || "cdlNumber"),
       'Licence number prefixed: another live driver already has it (B-100 unique licence number). Re-enter the correct number.'
FROM "_driver_cdl_dups";

UPDATE "Driver" d SET "cdlNumber" = 'DUP-' || left(d."id", 8) || '-' || d."cdlNumber"
FROM "_driver_cdl_dups" x WHERE d."id" = x."id";
DROP TABLE "_driver_cdl_dups";

-- 3. Partial unique indexes (live rows only; NOT representable in schema.prisma).
CREATE UNIQUE INDEX "Driver_phone_live_key" ON "Driver" (
  (CASE
     WHEN length(regexp_replace("phone", '\D', '', 'g')) = 11 AND left(regexp_replace("phone", '\D', '', 'g'), 1) = '1'
       THEN substr(regexp_replace("phone", '\D', '', 'g'), 2)
     ELSE regexp_replace("phone", '\D', '', 'g')
   END)
) WHERE "deletedAt" IS NULL AND "phone" IS NOT NULL AND regexp_replace("phone", '\D', '', 'g') <> '';

CREATE UNIQUE INDEX "Driver_cdlNumber_live_key" ON "Driver" (upper(regexp_replace("cdlNumber", '[\s-]', '', 'g')))
WHERE "deletedAt" IS NULL AND regexp_replace("cdlNumber", '[\s-]', '', 'g') <> '';
