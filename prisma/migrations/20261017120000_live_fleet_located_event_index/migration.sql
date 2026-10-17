-- LV-02 — `GET /api/live/fleet` took 25-27 s in production (79 units, 27 of them with no position
-- at all). `LiveFleetRepository.locatedProbe` asks, per vehicle, for the newest ACTIVE record WITH
-- a location:
--
--   WHERE "vehicleId" = $v AND "recordStatus" = 1 AND latitude IS NOT NULL AND longitude IS NOT NULL
--     AND "eventDateTime" <= $until  ORDER BY "eventDateTime" DESC LIMIT 1
--
-- and, for every unit the 2-day window did not answer, runs it again with no lower bound. Neither
-- existing index serves that predicate:
--   - ("vehicleId","eventDateTime") walks backwards over EVERY record of the unit, with a heap
--     fetch per row to test recordStatus/latitude, in every monthly partition — the unit's whole
--     history when it has never had a located record;
--   - ("recordStatus","eventDateTime"), which the planner may pick for the ORDER BY ... LIMIT 1,
--     walks every ACTIVE record of the WHOLE fleet per silent unit (measured on a 2.2 M-row
--     synthetic copy: 8.2 s and 52 M buffer hits for 27 silent units).
-- On this partial index the first entry in range IS the answer, and a unit with no located record
-- costs one empty index descent per partition (same copy: 0.5 ms, 432 buffers).
--
-- `EldEvent` is natively partitioned by month: CREATE INDEX on the parent builds it on every
-- partition (DEFAULT included) and on partitions created later. It cannot run CONCURRENTLY on a
-- partitioned parent, so each partition holds a SHARE lock (blocks INSERTs, not reads) while it is
-- indexed — apply in a quiet window, or first create each partition's matching index CONCURRENTLY
-- (the parent index then attaches them instead of rebuilding).

CREATE INDEX IF NOT EXISTS "EldEvent_vehicleId_eventDateTime_located_idx"
  ON "EldEvent" ("vehicleId", "eventDateTime")
  WHERE "recordStatus" = 1 AND latitude IS NOT NULL AND longitude IS NOT NULL;
