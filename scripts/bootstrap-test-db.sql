-- Phase 13J follow-up (D-105) — one-time/idempotent provisioning for the dedicated
-- `onebook_eld_test` database/`eld_test` role.
--
-- `prisma/migrations/20260910190500_append_only_revoke_hardening/migration.sql` (and the
-- `create_monthly_partition()` function it redefines) hardcode the append-only REVOKE to
-- `ARRAY['eld_dev', 'eld_prod']` (see that file's own header comment: it is deliberately
-- role-agnostic for the two roles that existed when it was written, `eld_dev`/`eld_prod`).
-- `eld_test` did not exist yet and is never in that array, and since `eld_test` is the OWNER
-- of onebook_eld_test's tables (CREATE DATABASE ... OWNER eld_test, migrate deploy ran as
-- eld_test), owner-implicit privileges mean `REVOKE ... FROM PUBLIC` alone does not block it
-- (same reasoning the migration's own header documents for why REVOKE must name the role).
--
-- Run this once after `prisma migrate deploy` against onebook_eld_test (and again after any
-- `prisma migrate reset`/re-provision of that DB). Never run against onebook_eld_dev/onebook_eld
-- — this only ever connects to onebook_eld_test in practice (see package.json `db:test:setup`).
--
-- Idempotent: REVOKE on a privilege never granted is a no-op; CREATE OR REPLACE FUNCTION is
-- always safe to re-run.

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['"EldEvent"', '"AuditLog"']
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON %s FROM eld_test', tbl);
  END LOOP;
END $$;

DO $$
DECLARE
  part text;
BEGIN
  FOR part IN
    SELECT inhrelid::regclass::text FROM pg_inherits WHERE inhparent = '"EldEvent"'::regclass
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON %s FROM eld_test', part);
  END LOOP;
END $$;

-- Also cover partitions `create_monthly_partition()` creates from now on inside this DB —
-- redefine it here (this DB only) to include eld_test alongside eld_dev/eld_prod.
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

    IF parent_table = 'EldEvent' THEN
      EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM PUBLIC', partition_name);
      FOREACH role_name IN ARRAY ARRAY['eld_dev', 'eld_prod', 'eld_test']
      LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
          EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM %I', partition_name, role_name);
        END IF;
      END LOOP;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;
