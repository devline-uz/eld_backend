-- Web-user ("User") emails: one canonical form, unique ignoring case.
--
-- The API now stores every address trimmed + lower-cased (`normalizeEmail` in
-- src/common/email/email-lookup.ts — invite `POST /users`, the B-84 email-change flow) and looks
-- users up case-insensitively (login, Google sign-in / invite acceptance, forgot / reset-code).
-- Rows written before that may be mixed-case or carry stray spaces.
--
-- Prisma's schema language can't express expression indexes, so "User_email_lower_key" exists
-- only here. It is whitelisted in src/core/prisma/custom-indexes.ts: `npm run migrate:dev` strips
-- any DROP/CREATE of it from a generated migration, and custom-indexes.spec.ts fails on a drop
-- without `-- custom-index: drop User_email_lower_key`. The plain "User_email_key" (@unique in
-- schema.prisma) stays as-is.
--
-- Steps:
--   0. Refuse (clear error, nothing changed) if two rows collide once normalised — those need a
--      human decision; this migration never merges or deletes accounts.
--   1. Normalise existing values (trim spaces / tabs / newlines + lower-case).
--   2. Unique index on lower("email").

-- 0. Guard.
DO $$
DECLARE
  collisions integer;
BEGIN
  SELECT count(*) INTO collisions
  FROM (
    SELECT lower(btrim("email", E' \t\r\n')) AS e
    FROM "User"
    GROUP BY 1
    HAVING count(*) > 1
  ) dup;
  IF collisions > 0 THEN
    RAISE EXCEPTION 'User.email: % address(es) collide case-insensitively; resolve them before applying 20261014120000_user_email_lowercase', collisions;
  END IF;
END $$;

-- 1. Normalise.
UPDATE "User"
SET "email" = lower(btrim("email", E' \t\r\n'))
WHERE "email" <> lower(btrim("email", E' \t\r\n'));

-- 2. Expression unique index (NOT representable in schema.prisma).
CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (lower("email"));
