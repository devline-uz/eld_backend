-- Append-only enforcement hardening (tz.md §5.5, §18, §23)
--
-- Bug fixed here: the initial migration's REVOKE was hardcoded to `eld_dev`
-- (`REVOKE UPDATE, DELETE ON "EldEvent" FROM eld_dev;`). Applied to the prod
-- database (owned by `eld_prod`), that statement is a harmless no-op and
-- leaves EldEvent/AuditLog fully UPDATE/DELETE-able in prod — the one
-- environment where the invariant matters most. This migration is:
--   - role-agnostic: it revokes from PUBLIC and from every DB role that
--     actually exists (`eld_dev`, `eld_prod`), so the same file is correct
--     on both databases;
--   - idempotent: REVOKE on a privilege that was never granted is a no-op,
--     and every DO block is guarded so re-applying this file is always safe.
--
-- It also closes a partition-level hole found while testing this fix:
-- REVOKE on a PARTITIONED PARENT table does NOT propagate to its child
-- partitions. Each partition starts with its own, independently-empty ACL,
-- so its owning role keeps full *implicit* owner privileges — including
-- UPDATE/DELETE — on that specific partition until REVOKE is applied to it
-- directly. Verified with `UPDATE "EldEvent_y2026m09" SET ... ` succeeding
-- as `eld_dev` even though `UPDATE "EldEvent" SET ...` was already blocked.
-- `TelemetryPoint` is intentionally left alone here: tz.md does not require
-- it to be append-only (§5.6 has no REVOKE requirement, unlike §5.5/§18).

-- ---------------------------------------------------------------------------
-- 1) Parent tables: EldEvent, AuditLog
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl text;
  role_name text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['"EldEvent"', '"AuditLog"']
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON %s FROM PUBLIC', tbl);
    FOREACH role_name IN ARRAY ARRAY['eld_dev', 'eld_prod']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE UPDATE, DELETE ON %s FROM %I', tbl, role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Existing EldEvent child partitions (including the DEFAULT catch-all) —
--    direct access to a partition bypasses parent-level REVOKE, see above.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  part text;
  role_name text;
BEGIN
  FOR part IN
    SELECT inhrelid::regclass::text FROM pg_inherits WHERE inhparent = '"EldEvent"'::regclass
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON %s FROM PUBLIC', part);
    FOREACH role_name IN ARRAY ARRAY['eld_dev', 'eld_prod']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE UPDATE, DELETE ON %s FROM %I', part, role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Future partitions: redefine create_monthly_partition() so every
--    EldEvent partition it creates from now on (retention.processor, going
--    forward) is locked down at creation time instead of as an afterthought.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_monthly_partition(parent_table text, month_start date)
RETURNS void AS $$
DECLARE
  partition_name text := parent_table || '_y' || to_char(month_start, 'YYYY') || 'm' || to_char(month_start, 'MM');
  range_start date := date_trunc('month', month_start)::date;
  range_end   date := (date_trunc('month', month_start) + interval '1 month')::date;
  role_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      partition_name, parent_table, range_start, range_end
    );

    -- Only EldEvent is append-only (tz.md §5.5); TelemetryPoint partitions
    -- stay writable since retention.processor's normal DROP-after-13-months
    -- path is the only mutation they ever need.
    IF parent_table = 'EldEvent' THEN
      EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM PUBLIC', partition_name);
      FOREACH role_name IN ARRAY ARRAY['eld_dev', 'eld_prod']
      LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
          EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM %I', partition_name, role_name);
        END IF;
      END LOOP;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;
