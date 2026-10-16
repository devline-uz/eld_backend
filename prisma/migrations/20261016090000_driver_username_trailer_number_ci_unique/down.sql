-- Reverts 20261016090000_driver_username_trailer_number_ci_unique (B3-06). The raw-value live
-- keys and the app-level case-insensitive pre-checks remain.
-- custom-index: drop Driver_username_lower_live_key
DROP INDEX IF EXISTS "Driver_username_lower_live_key";
-- custom-index: drop Trailer_number_upper_live_key
DROP INDEX IF EXISTS "Trailer_number_upper_live_key";
