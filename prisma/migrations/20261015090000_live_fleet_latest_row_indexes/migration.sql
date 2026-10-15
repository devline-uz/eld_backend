-- LV-01 — `GET /api/live/fleet` took 5.6 s in production (75 units / ~77 drivers). Two partial
-- indexes for the reads it (and GET /drivers/roster, GET /dashboard/summary) runs on every poll.
-- Prisma's schema language can't express partial indexes, so both exist only here and are
-- whitelisted in src/core/prisma/custom-indexes.ts.
--
-- 1. "TelemetryPoint_vehicleId_time_fix_idx" — the "latest point WITH a GPS fix per vehicle"
--    probe (`LiveFleetRepository.telemetryProbe`, `... AND latitude IS NOT NULL AND longitude IS
--    NOT NULL ORDER BY "time" DESC LIMIT 1`). On ("vehicleId","time") alone it walks backwards,
--    with a heap fetch per row, over every fix-less point (PT SDK 6.11 points may carry no fix)
--    until it finds one — the WHOLE history of a unit that has never had a fix, in every monthly
--    partition. On this index the first entry is the answer.
--
-- 2. "EldEvent_driverId_eventDateTime_duty_idx" — the duty-status / PC-YM reads
--    (`HosRecalcRepository.findEventsForDrivers` for the HOS clocks and
--    `LiveFleetRepository.activeSpecialDriving`, both `"eventType" IN (1, 3)` over a ~10-day
--    window). On ("driverId","eventDateTime") they read every event of the window — intermediate
--    logs, engine power, login, diagnostics — and discard most of them; this index holds only the
--    rows they keep.
--
-- Both tables are natively partitioned by month: CREATE INDEX on the parent builds the index on
-- every partition (DEFAULT included) and on partitions created later. It cannot run CONCURRENTLY
-- on a partitioned parent, so it holds a SHARE lock (blocks INSERTs, not reads) per partition while
-- that partition is indexed — apply in a quiet window. To avoid even that on a very large
-- TelemetryPoint: create each partition's index CONCURRENTLY first, then run this migration (the
-- parent index attaches the existing matching partition indexes instead of rebuilding them).

CREATE INDEX IF NOT EXISTS "TelemetryPoint_vehicleId_time_fix_idx"
  ON "TelemetryPoint" ("vehicleId", "time")
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

CREATE INDEX IF NOT EXISTS "EldEvent_driverId_eventDateTime_duty_idx"
  ON "EldEvent" ("driverId", "eventDateTime")
  WHERE "eventType" IN (1, 3);
