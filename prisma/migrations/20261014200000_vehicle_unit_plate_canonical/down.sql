-- DOWN migration for 20261014200000_vehicle_unit_plate_canonical
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- Drops the canonical unit-number index. The UP also normalised stored plates (upper-cased,
-- spaces / dashes removed, '' -> NULL); that is not undone (the original spellings are not kept).
-- custom-index: drop Vehicle_unitNumber_canonical_live_key
DROP INDEX IF EXISTS "Vehicle_unitNumber_canonical_live_key";
