-- Bootstrap script for the retention maintenance role (tz.md §5.5, §18, §22 compliance
-- checklist "RODS 6 oy, audit 24 oy saqlanadi").
--
-- WHY THIS IS A SEPARATE, MANUALLY-APPLIED SCRIPT (NOT a prisma/migrations/*.sql file):
-- `EldEvent` and `AuditLog` have UPDATE/DELETE revoked from the app role (eld_dev/eld_prod)
-- at the DB level (B-009, migration 20260910190500_append_only_revoke_hardening). That
-- revoke is intentional and must never be undone by granting the app role DELETE back —
-- see retention.processor design notes (decisions.md D-0xx). `EldEvent` retention does not
-- need extra privileges: DETACH PARTITION / DROP TABLE are DDL, which the *owning* role
-- (eld_dev/eld_prod) always retains regardless of the DML REVOKE. `AuditLog`, however, is a
-- single flat table (not partitioned) — its 24-month purge is a genuine DELETE, which the
-- app role must never be able to run generally. So a distinct, narrowly-scoped role is
-- required, and Postgres CREATE ROLE needs superuser/CREATEROLE — a privilege the app role
-- deliberately does not have (see prisma/migrations init: only `Create DB`, not
-- `Create role`). Running this via `prisma migrate dev`/`migrate deploy` (executed as the
-- app role) would therefore always fail with "permission denied to create role" and break
-- every other agent/CI job that runs migrations. This script is applied ONCE per
-- environment by an operator/superuser connection (e.g. `docker exec <pg-container> psql -U
-- postgres -d <db> -f scripts/bootstrap-retention-role.sql`), same class of one-time
-- privileged bootstrap as the underlying `eld_dev`/`eld_prod` roles themselves.
--
-- Idempotent: safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eld_retention_svc') THEN
    CREATE ROLE eld_retention_svc LOGIN PASSWORD :'retention_password' CONNECTION LIMIT 3;
  END IF;
END $$;

GRANT CONNECT ON DATABASE :"dbname" TO eld_retention_svc;
GRANT USAGE ON SCHEMA public TO eld_retention_svc;
-- SELECT: needed to stream/verify the rows being archived to S3 before the purge DELETE.
-- DELETE: the sole reason this role exists — the app role never gets this back.
GRANT SELECT, DELETE ON "AuditLog" TO eld_retention_svc;
