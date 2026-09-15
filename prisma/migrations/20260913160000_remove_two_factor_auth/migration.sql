-- D-050: 2FA/TOTP removed entirely at explicit user request (2026-09-13).
-- Drops the three User columns that backed TOTP enrolment/verification.
ALTER TABLE "User" DROP COLUMN IF EXISTS "twoFactorSecret";
ALTER TABLE "User" DROP COLUMN IF EXISTS "twoFactorEnabled";
ALTER TABLE "User" DROP COLUMN IF EXISTS "recoveryCodes";
