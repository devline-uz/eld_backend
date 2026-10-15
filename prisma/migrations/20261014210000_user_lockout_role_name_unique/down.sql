-- Reverts 20261014210000_user_lockout_role_name_unique (CODE-082/087). Lockout counters are lost.
-- The Role.name trim is one-way data normalisation and is NOT undone.
DROP INDEX "Role_name_lower_key";

ALTER TABLE "User" DROP COLUMN "lockedUntil";
ALTER TABLE "User" DROP COLUMN "failedLoginCount";
