-- Perf fix (bugs.md B-0xx): GET /api/dvir default listing sorts by `submittedAt` DESC with
-- no filter. Without an index on that column alone Postgres does a full seq scan + sort of the
-- whole (37k-row, 47MB) Dvir table, which is cheap once cached but very slow (multi-second) on
-- a cold buffer cache. The existing [vehicleId, submittedAt] / [driverId, submittedAt] composite
-- indexes don't help an unfiltered list. Adding a plain index on submittedAt turns it into an
-- index scan returning only the page requested.
CREATE INDEX "Dvir_submittedAt_idx" ON "Dvir"("submittedAt");
