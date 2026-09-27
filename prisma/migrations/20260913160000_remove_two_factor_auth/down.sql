-- DOWN migration for 20260913160000_remove_two_factor_auth
-- (runner: scripts/migrate-updown-dev.sh — dev database only, replayed against an empty
-- scratch database, so no data-preservation concerns here).
--
-- Re-adds the three columns the UP dropped (D-050: 2FA/TOTP removed entirely). Postgres
-- always appends ADD COLUMN at the end of the table (by attnum), so a plain ADD COLUMN
-- would leave the columns after "createdAt" instead of their original position between
-- "status" and "lastActiveAt" — the migrate-updown-dev.sh comparison is a literal
-- pg_dump text diff, so column order must match exactly. The scratch DB is always empty
-- at this point (only init + this migration have run), so a full table rebuild in the
-- original column order is safe and cheap.

ALTER TABLE "User" RENAME TO "User_reorder_tmp";
ALTER TABLE "User_reorder_tmp" RENAME CONSTRAINT "User_pkey" TO "User_reorder_tmp_pkey";
ALTER INDEX "User_email_key" RENAME TO "User_reorder_tmp_email_key";
ALTER INDEX "User_googleUid_key" RENAME TO "User_reorder_tmp_googleUid_key";
ALTER INDEX "User_status_idx" RENAME TO "User_reorder_tmp_status_idx";

ALTER TABLE "Session" DROP CONSTRAINT IF EXISTS "Session_userId_fkey";
ALTER TABLE "Driver" DROP CONSTRAINT IF EXISTS "Driver_fleetManagerId_fkey";
ALTER TABLE "ApiKey" DROP CONSTRAINT IF EXISTS "ApiKey_createdById_fkey";

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "googleUid" TEXT,
    "authProvider" "AuthProvider" NOT NULL DEFAULT 'PASSWORD',
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "jobTitle" TEXT,
    "phone" TEXT,
    "roleId" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "twoFactorSecret" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "recoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastActiveAt" TIMESTAMP(3),
    "invitedById" TEXT,
    "invitedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

INSERT INTO "User" ("id", "email", "passwordHash", "googleUid", "authProvider", "firstName",
  "lastName", "jobTitle", "phone", "roleId", "status", "lastActiveAt", "invitedById",
  "invitedAt", "createdAt")
SELECT "id", "email", "passwordHash", "googleUid", "authProvider", "firstName", "lastName",
  "jobTitle", "phone", "roleId", "status", "lastActiveAt", "invitedById", "invitedAt", "createdAt"
FROM "User_reorder_tmp";

DROP TABLE "User_reorder_tmp";

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_googleUid_key" ON "User"("googleUid");
CREATE INDEX "User_status_idx" ON "User"("status");

ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_fleetManagerId_fkey" FOREIGN KEY ("fleetManagerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
