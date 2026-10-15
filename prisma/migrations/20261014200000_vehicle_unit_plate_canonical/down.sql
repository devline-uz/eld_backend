-- Reverts 20261014200000_vehicle_unit_plate_canonical. Drops the canonical unit-number index only.
-- Plate normalisation (upper-case, no spaces/dashes, '' -> NULL) is one-way data and is NOT undone;
-- original spellings were not kept. "Vehicle_unitNumber_live_key" stays.
DROP INDEX "Vehicle_unitNumber_canonical_live_key";
