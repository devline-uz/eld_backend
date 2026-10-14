-- CODE-082 — per-account password lockout (consecutive failures + lock window).
-- CODE-087 — role display names unique ignoring case and surrounding spaces.
--
-- "Role_name_lower_key" is an expression index Prisma's schema language can't express; it is
-- whitelisted in src/core/prisma/custom-indexes.ts like "User_email_lower_key".
--
-- Steps:
--   0. Refuse (clear error, nothing changed) if two roles share a name once normalised — renaming a
--      role is a human decision; this migration never renames or merges roles. Read-only pre-check:
--        SELECT lower(btrim(name, E' \t\r\n')) AS canonical, count(*), array_agg(id), array_agg(key)
--        FROM "Role" GROUP BY 1 HAVING count(*) > 1;
--   1. Trim stored names.
--   2. Lockout columns (additive, defaults — safe to apply before or with the code).
--   3. Unique index on lower(btrim(name)).

-- 0. Guard.
DO $$
DECLARE
  collisions integer;
BEGIN
  SELECT count(*) INTO collisions
  FROM (
    SELECT lower(btrim("name", E' \t\r\n')) AS n
    FROM "Role"
    GROUP BY 1
    HAVING count(*) > 1
  ) dup;
  IF collisions > 0 THEN
    RAISE EXCEPTION 'Role.name: % name(s) collide case-insensitively; rename those roles before applying 20261014210000_user_lockout_role_name_unique', collisions;
  END IF;
END $$;

-- 1. Normalise.
UPDATE "Role"
SET "name" = btrim("name", E' \t\r\n')
WHERE "name" <> btrim("name", E' \t\r\n');

-- 2. Lockout columns.
ALTER TABLE "User" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "lockedUntil" TIMESTAMP(3);

-- 3. Expression unique index (NOT representable in schema.prisma).
CREATE UNIQUE INDEX "Role_name_lower_key" ON "Role" (lower(btrim("name", E' \t\r\n')));
