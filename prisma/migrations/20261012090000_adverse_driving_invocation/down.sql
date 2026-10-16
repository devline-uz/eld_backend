-- DOWN migration for 20261012090000_adverse_driving_invocation
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- Drops the invocation table (and its index / FK with it). Every recorded adverse-driving
-- invocation is lost; `Driver.adverseDrivingEnabled` is untouched.
DROP TABLE IF EXISTS "AdverseDrivingInvocation";
