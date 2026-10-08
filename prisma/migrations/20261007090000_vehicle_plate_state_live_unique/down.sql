-- DOWN migration for 20261007090000_vehicle_plate_state_live_unique
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- custom-index: drop Vehicle_plate_state_live_key
--
-- The UP created exactly one object (the partial unique index); dropping it restores the schema.
-- The UP's data steps (plate normalisation trim + upper-case, and clearing duplicate live plates
-- with a note appended to "Vehicle"."notes") are deliberately NOT reversed: they are
-- non-destructive and the cleared values are preserved in the unit notes.
DROP INDEX IF EXISTS "Vehicle_plate_state_live_key";
