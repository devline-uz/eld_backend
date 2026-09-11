-- DOWN migration for 20260910190500_append_only_revoke_hardening
-- (runner: scripts/migrate-updown-dev.sh — dev database only).
--
-- The UP did two things: (1) revoked UPDATE/DELETE on EldEvent/AuditLog and on every
-- existing EldEvent partition from PUBLIC and from each app role that exists, and
-- (2) redefined create_monthly_partition() so new EldEvent partitions are locked down
-- at creation time.
--
-- ⚠️ Re-granting UPDATE/DELETE on an append-only ledger is exactly what tz.md §5.5/§18/§23
-- forbid in a live database. This file exists ONLY so the migration's reverse path is
-- proven on a throw-away dev database by the up/down runner; it must never be run against
-- onebook_eld (prod) or against a dev database that is being used for anything else.
-- The runner enforces that by operating on a scratch database it creates and drops itself.

-- 1) Restore exactly what this migration took away — nothing more.
--
--    On the PARENT tables the *init* migration already ran
--    `REVOKE UPDATE, DELETE ON "EldEvent"/"AuditLog" FROM eld_dev`, so for an
--    eld_dev-owned database (dev) the pre-migration state is already "no UPDATE/DELETE"
--    and this down must NOT grant it back. For any other owner (prod: eld_prod, where
--    init's hardcoded eld_dev REVOKE was a no-op) the owner did still hold those
--    privileges beforehand, so they are restored.
DO $$
DECLARE
  tbl text;
  owner_name text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['"EldEvent"', '"AuditLog"']
  LOOP
    SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid = tbl::regclass;
    IF owner_name <> 'eld_dev' THEN
      EXECUTE format('GRANT UPDATE, DELETE ON %s TO %I', tbl, owner_name);
    END IF;
  END LOOP;
END $$;

--    Child partitions had no REVOKE of any kind before this migration (that was the hole
--    it closed), so every partition's owner gets its implicit privileges back.
DO $$
DECLARE
  part text;
  owner_name text;
BEGIN
  FOR part IN
    SELECT inhrelid::regclass::text FROM pg_inherits WHERE inhparent = '"EldEvent"'::regclass
  LOOP
    SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid = part::regclass;
    EXECUTE format('GRANT UPDATE, DELETE ON %s TO %I', part, owner_name);
  END LOOP;
END $$;

-- 2) Restore create_monthly_partition() to its pre-hardening (init) definition.
CREATE OR REPLACE FUNCTION create_monthly_partition(parent_table text, month_start date)
RETURNS void AS $$
DECLARE
  partition_name text := parent_table || '_y' || to_char(month_start, 'YYYY') || 'm' || to_char(month_start, 'MM');
  range_start date := date_trunc('month', month_start)::date;
  range_end   date := (date_trunc('month', month_start) + interval '1 month')::date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      partition_name, parent_table, range_start, range_end
    );
  END IF;
END;
$$ LANGUAGE plpgsql;
