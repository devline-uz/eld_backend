# Deploy & Operations

Source of truth: `backend/tz.md` §22 (deploy/DB) and §19 (performance). This
doc only operationalizes it — if they disagree, `tz.md` wins.

## Environments

Dev and prod share one machine, one Postgres instance, and one Redis
instance, but are strictly separated by name/role/index/bucket:

| | Dev | Prod |
|---|---|---|
| DB name | `onebook_eld_dev` | `onebook_eld` |
| DB role | `eld_dev` | `eld_prod` |
| Redis DB index | `1` | `0` |
| S3 bucket | `onebook-dev` | `onebook-prod` |
| API port | `3001` | `3000` |
| Env file | `.env.development` | `.env.production` |

Compose file: `backend/docker-compose.yml`. Services: `postgres`, `redis`,
`minio` (+ `minio-init`), `api`, `worker`, `api-dev`.

## Migration flow (tz.md §22.3.3) — fixed order, no shortcuts

```
1) On dev:          npx prisma migrate dev --name <change>
2) Verify:          npm run test:integration     (runs against dev DB)
3) On prod:         npx prisma migrate deploy     (prod DSN only)
```

Rules:
- `prisma migrate dev` is **never** run against the prod DSN. It can drop
  data; `core/config/db-guard.ts` (owned by `eld-architect`) throws before
  the app even boots if a dev-mode process resolves a prod DB name, or a
  prod-mode process resolves a dev DB name, or a prod-mode process
  connects with a non-`eld_prod` user.
- `npm run db:reset:dev` (`scripts/db-reset-dev.sh`) drops, migrates, and
  seeds the dev DB. It refuses to run when `NODE_ENV=production` **or**
  when the resolved `DATABASE_URL` database name is `onebook_eld` —
  two independent checks, matching the two-way guard in tz.md §22.3.4.
- Nightly cron: `npm run db:check-drift` (`scripts/check-drift.sh`) diffs
  the dev and prod schemas via `prisma migrate diff`. Any difference
  exits non-zero with the SQL diff printed, which the cron wrapper turns
  into an email alert. Zero drift is the only passing state — dev and
  prod schemas must always be identical (data differs, structure doesn't).

## Backups & restore (tz.md §22.4)

- **Nightly:** `scripts/backup.sh` runs `pg_dump` of `onebook_eld`
  **only** (refuses to run against any other DSN). Output lands in
  `BACKUP_DEST` (default `/var/backups/onebook-eld`), then must be synced
  to a server that is physically different from this one — the script
  itself does not perform that transfer; wire cron to also rsync/rclone
  the destination directory off-box.
- **WAL archiving + PITR (7 days):** configure `archive_mode = on` and an
  `archive_command` in postgresql.conf that ships WAL segments to the
  same off-server destination, retaining 7 days. This is host-level
  Postgres config, not something `docker-compose.yml` sets by default —
  set it up on the running `postgres` container/volume before relying on
  PITR.
- **Monthly restore drill:** once a month, restore the latest dump (plus
  WAL replay for a PITR point) into a scratch database on a separate
  instance, and record the result below.

  | Date | Performed by | Dump used | Result | Notes |
  |---|---|---|---|---|
  | _(none yet — first drill pending)_ | | | | |

## Monitoring & alerts (tz.md §22.5)

- Logs: pino, JSON, every log line carries `traceId`.
- Metrics: Prometheus scrape at `/metrics`.
- Errors: Sentry, **separate projects** for dev and prod
  (`SENTRY_DSN`/`SENTRY_ENVIRONMENT` differ per `.env.*`).
- Health endpoints: `/health/live`, `/health/ready`, `/health/deep`.
- Alert thresholds (page/email on any of):
  - Ingest lag > 5 minutes
  - HOS recalculation queue depth > 500
  - API p95 latency > 500 ms
  - Disk usage > 80%
  - Schema drift detected (see `db:check-drift` above)

## Resource fencing (tz.md §22.3.4)

Enforced in `docker/postgres/init/01_create_roles_and_dbs.sql` and
`docker-compose.yml`:

- `eld_dev` — `CONNECTION LIMIT 10`, `statement_timeout = 30s`.
- `eld_prod` — `CONNECTION LIMIT 40`, `statement_timeout = 60s`.
- `REVOKE ALL ON DATABASE onebook_eld FROM eld_dev` (and the mirror image
  for `eld_prod` on `onebook_eld_dev`).
- Redis: dev DB 1, prod DB 0, `maxmemory-policy noeviction`.
- `api-dev` container: CPU 1, RAM 1 GB (see `deploy.resources.limits` in
  `docker-compose.yml`).

## Secrets

Real credentials (DB passwords, JWT secrets, Firebase keys, Sentry DSNs,
MinIO keys) are never committed or baked into an image layer. They are
mounted/injected from the server's secrets folder into `.env.development`
and `.env.production` (copied from the `.example` templates in
`backend/`), which `docker-compose.yml` loads via `env_file`.

## What's left for later phases

- `db-guard.ts`, Prisma schema, and `prisma/seed.ts` are owned by
  `eld-architect` / `eld-prisma-db` (Phase 1 app-layer work) — this slice
  only prepares the infra they'll run against.
- `api`/`worker` images have not been built yet; the source tree is still
  being written. Build once `npm run build` succeeds.
- Real DB/Redis/MinIO/JWT/Firebase/Sentry secrets must be generated and
  placed in the server secrets folder, then referenced from
  `.env.development` / `.env.production` (not committed).
- Caddy routes in `docker/caddy/Caddyfile` use placeholder hostnames —
  swap in the real domains and import into the box's live Caddyfile.
- Cron wiring for `db:check-drift` (nightly) and `backup.sh` (nightly)
  has not been installed yet — only the scripts exist.
- WAL archiving/PITR config and the first monthly restore drill are not
  done yet — see the backups section above.
