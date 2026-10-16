-- Driver username and trailer number: unique among live rows ignoring case (B3-06).
--
-- The API already refuses "jdoe" next to "JDoe" and "tr-01" next to "TR-01" (BE-20 / BE-07,
-- `DriversRepository.findByUsername`, `TrailersRepository.findByNumber`), but that is an
-- app-level pre-check: "Driver_username_live_key" and "Trailer_number_live_key" compare the raw
-- value, so concurrent creates could still store case variants (driver login by username would
-- then be ambiguous). This migration:
--   0. refuses (clear error, nothing changed) when live rows already collide ignoring case and
--      surrounding spaces — those need a human decision; it never merges, renames or deletes;
--   1. adds expression partial unique indexes with the same live-row predicate as the existing
--      keys ("deletedAt" IS NULL). The existing raw-value keys stay as-is.
--
-- Find collisions beforehand with the query in the B3-06 notes (GROUP BY lower(btrim("username"))
-- / upper(btrim("number")) WHERE "deletedAt" IS NULL HAVING count(*) > 1).
--
-- Both indexes exist only here; they are whitelisted in src/core/prisma/custom-indexes.ts.

-- 0. Guards.
DO $$
DECLARE
  username_collisions integer;
  trailer_collisions integer;
BEGIN
  SELECT count(*) INTO username_collisions
  FROM (
    SELECT lower(btrim("username"))
    FROM "Driver"
    WHERE "deletedAt" IS NULL
    GROUP BY 1
    HAVING count(*) > 1
  ) dup;
  IF username_collisions > 0 THEN
    RAISE EXCEPTION 'Driver.username: % live username(s) collide ignoring case; rename or delete the duplicates before applying 20261016090000_driver_username_trailer_number_ci_unique', username_collisions;
  END IF;

  SELECT count(*) INTO trailer_collisions
  FROM (
    SELECT upper(btrim("number"))
    FROM "Trailer"
    WHERE "deletedAt" IS NULL
    GROUP BY 1
    HAVING count(*) > 1
  ) dup;
  IF trailer_collisions > 0 THEN
    RAISE EXCEPTION 'Trailer.number: % live trailer number(s) collide ignoring case; rename or delete the duplicates before applying 20261016090000_driver_username_trailer_number_ci_unique', trailer_collisions;
  END IF;
END $$;

-- 1. Expression partial unique indexes (NOT representable in schema.prisma).
CREATE UNIQUE INDEX "Driver_username_lower_live_key"
  ON "Driver" (lower(btrim("username")))
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "Trailer_number_upper_live_key"
  ON "Trailer" (upper(btrim("number")))
  WHERE "deletedAt" IS NULL;
