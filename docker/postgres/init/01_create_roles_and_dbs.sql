-- OneBook ELD — bootstrap roles and databases (tz.md §22.3.4)
-- Runs once, automatically, on first Postgres container init
-- (docker-entrypoint-initdb.d). Idempotent-guarded with IF NOT EXISTS /
-- DO blocks so a re-run (e.g. volume kept, script re-applied by hand)
-- does not error out.

-- Passwords are supplied via the server secrets folder, never hardcoded
-- here. This init script only sets up the identities/permissions
-- structure; actual passwords are set by 02_set_passwords.sql, which is
-- templated from the secrets folder at deploy time (see docs/deploy.md).

DO
$$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eld_prod') THEN
    CREATE ROLE eld_prod WITH LOGIN PASSWORD 'CHANGE_ME_PROD';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eld_dev') THEN
    CREATE ROLE eld_dev WITH LOGIN PASSWORD 'CHANGE_ME_DEV';
  END IF;
END
$$;

-- Databases (owned by their respective role).
SELECT 'CREATE DATABASE onebook_eld OWNER eld_prod'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'onebook_eld')
\gexec

SELECT 'CREATE DATABASE onebook_eld_dev OWNER eld_dev'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'onebook_eld_dev')
\gexec

-- ---------------------------------------------------------------------------
-- Resource fencing (tz.md §22.3.4, verbatim requirements)
-- ---------------------------------------------------------------------------

-- eld_dev: capped connections + short statement timeout so a runaway dev
-- query/migration cannot starve prod on the shared Postgres instance.
ALTER ROLE eld_dev CONNECTION LIMIT 10;
ALTER ROLE eld_dev SET statement_timeout = '30s';

-- eld_prod: higher ceiling, longer timeout for legitimate long-running
-- prod queries (reports, drift checks run with the prod DSN, etc).
ALTER ROLE eld_prod CONNECTION LIMIT 40;
ALTER ROLE eld_prod SET statement_timeout = '60s';

-- Two-way isolation: eld_dev must never be able to see/touch the prod
-- database, even by accident (wrong DSN, stray migration, etc).
REVOKE ALL ON DATABASE onebook_eld FROM eld_dev;
REVOKE ALL ON DATABASE onebook_eld FROM PUBLIC;

-- Mirror isolation the other direction: eld_prod has no business in dev.
REVOKE ALL ON DATABASE onebook_eld_dev FROM eld_prod;
REVOKE ALL ON DATABASE onebook_eld_dev FROM PUBLIC;

-- Each role gets full rights on its own database only.
GRANT ALL PRIVILEGES ON DATABASE onebook_eld TO eld_prod;
GRANT ALL PRIVILEGES ON DATABASE onebook_eld_dev TO eld_dev;
