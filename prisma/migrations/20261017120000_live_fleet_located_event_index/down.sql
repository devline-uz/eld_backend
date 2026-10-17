-- Reverts 20261017120000_live_fleet_located_event_index (LV-02). Reads stay correct, only slower.
-- custom-index: drop EldEvent_vehicleId_eventDateTime_located_idx
DROP INDEX IF EXISTS "EldEvent_vehicleId_eventDateTime_located_idx";
