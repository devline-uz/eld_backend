-- DOWN migration for 20261014120000_user_email_lowercase
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
-- The email normalisation (trim + lower-case) is not reversed: the original casing is not kept and
-- lower-case addresses are valid for every flow.

-- custom-index: drop User_email_lower_key
DROP INDEX IF EXISTS "User_email_lower_key";
