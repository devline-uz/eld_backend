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
- **Monthly restore drill:** `scripts/restore-drill.sh` — dumps
  `onebook_eld` (or restores an existing `DUMP_FILE`), restores it into a
  throwaway scratch database (`onebook_eld_restore_drill_<pid>_<rand>`,
  dropped on exit — never `onebook_eld`/`onebook_eld_dev`), verifies row
  counts and that the append-only `REVOKE UPDATE/DELETE` privileges on
  `EldEvent`/`AuditLog` survived the round trip. Run it once a month and
  record the result below. "On a separate instance" (ideal) requires
  pointing `POSTGRES_SUPERUSER_PASSWORD`/`--host` at that instance's
  postgres; the script itself works against any reachable postgres server
  — this box's own `onebook-postgres` container is what Phase 12's first
  drill below used, since a second physical instance was not available in
  that session.

  | Date | Performed by | Dump used | Result | Notes |
  |---|---|---|---|---|
  | 2026-09-11 | eld-devops (Phase 12, automated) | fresh `pg_dump` of `onebook_eld` via `scripts/restore-drill.sh` | PASS | Prod DB was empty at drill time (0 rows in `User`/`Driver`/`Vehicle`/`EldEvent`/`DailyLog`/`AuditLog` — before/after matched); append-only privileges on `EldEvent`/`AuditLog` confirmed preserved post-restore; scratch DB dropped on exit; ~22s total. Restored on this box's own postgres container, not a separate physical instance — re-run against a genuinely separate host once one exists. See bugs.md B-026 for two bugs this drill's first run surfaced and fixed in `backup.sh`/`restore-drill.sh` itself. |

## Monitoring & alerts (tz.md §22.5)

- Logs: pino, JSON, every log line carries `traceId`.
- Metrics: Prometheus scrape at `/metrics` on **both** containers —
  `api`/`api-dev` on their normal `PORT`, and `worker` on its own
  `WORKER_HEALTH_PORT` (default `3002`, see `src/worker.ts`) since the
  worker has no Nest HTTP stack of its own. Scrape config:
  `docker/prometheus/prometheus.yml`. Alert rules (Prometheus/Alertmanager
  format): `docker/prometheus/alerts.yml`. Neither is run by
  `docker-compose.yml` itself — hand them to whatever Prometheus instance
  already runs on the box, same as `docker/caddy/Caddyfile`.
- Errors: Sentry, real `@sentry/node` client (`src/core/observability/sentry.service.ts`,
  `Sentry.init()` runs once per process via `ObservabilityModule`, imported by both
  `app.module.ts` and `worker.ts`). **Separate projects** for dev and prod
  (`SENTRY_DSN`/`SENTRY_ENVIRONMENT` differ per `.env.*`); unset `SENTRY_DSN` degrades to
  log-only (no error, by design).
- Health endpoints: `/health/live`, `/health/ready`, `/health/deep` on the
  API; the worker exposes the same three paths on `WORKER_HEALTH_PORT`
  (bare `http` listener, not Nest's HTTP stack — see `src/worker.ts`).
  `/health/live` on the worker is backed by `WorkerHeartbeatService`
  (`src/modules/health/worker-heartbeat.service.ts`), not just
  process-presence — see B-024/B-026 in `bugs.md` for why that distinction
  matters: a DI wiring bug once crashed the worker at boot while the old
  `node -e "process.exit(0)"` compose healthcheck stayed green throughout.
- Alert thresholds (page/email on any of — see `docker/prometheus/alerts.yml`
  for the exact PromQL):
  - Ingest lag > 5 minutes (`IngestLagHigh` — currently a route-latency
    proxy; a direct `receivedAt`→`processedAt` lag gauge is a follow-up)
  - HOS recalculation queue depth > 500 (`QueueBacklog`, via
    `onebook_queue_depth` from `QueueDepthService`)
  - API p95 latency > 500 ms (`ApiP95LatencyHigh`)
  - Disk usage > 80% (`DiskUsageHigh`, requires `node_exporter`)
  - Schema drift detected (`SchemaDrift`; `scripts/check-drift.sh` also
    writes a `TEXTFILE_COLLECTOR_DIR` metric when that env var is set)
  - Worker not ticking (`WorkerNotTicking` — B-024's failure mode)
  - Failed jobs, incl. eRODS transfer and the nightly HOS drift sweep
    specifically (`JobsFailing`, `TransferJobsFailing`, `HosDriftJobFailing`)
  - DB connection loss (`DatabaseUnreachable`, via `/health/ready` 503s)
  - DB connection pool saturation, i.e. approaching a role's `CONNECTION
    LIMIT` (`PostgresConnectionsNearLimit`/`EldDevConnectionsNearLimit`,
    B-038 — requires `postgres_exporter` scraped, see
    `docker/prometheus/prometheus.yml`)
  - Any scrape target down (`OneBookTargetDown`)

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

## DB connection pool budget (tz.md §19/§22.3, B-038)

Postgres itself allows `max_connections = 100` on this box's shared instance
(`SHOW max_connections;` against `onebook-postgres`) — comfortably above what
either environment's role fence needs, so this is **not** the constraint.
The real ceiling is the per-role `CONNECTION LIMIT` from the resource-fencing
table above, which is hard-enforced by Postgres independently of whatever
Prisma's own `connection_limit` query-string param says. A Prisma pool
configured larger than what's left under the role's `CONNECTION LIMIT` does
not get more connections — it just fails faster with `P2024` once the role
cap is hit.

**Prod — `eld_prod`, `CONNECTION LIMIT 40`:**
Only two processes ever hold the `eld_prod` role open: `api` and `worker`,
each one `PrismaService` (one pool per process — `@Global` singleton, see
`src/core/prisma/prisma.service.ts`; the 10+ BullMQ processors under
`src/workers/*.processor.ts` share the worker's single pool, they do not
each open their own). tz.md §19's `connection_limit=20` is this budget:
`api(20) + worker(20) = 40` — exactly the role's `CONNECTION LIMIT`, zero
spare. That is intentional headroom-free sizing for the two long-running
containers; it leaves no slack for an interactive `psql`/`prisma migrate
deploy` session run at the same moment — those are infrequent, operator-run,
and should be timed to avoid a simultaneous prod traffic peak.

**Dev — `eld_dev`, `CONNECTION LIMIT 10`:**
tz.md §19's blanket `connection_limit=20` does **not** fit here — it would
exceed the role's own hard cap of 10 even before counting anything else, and
Prisma would just hit `P2024` sooner, not later. Dev's `.env.development` is
also loaded directly by `test/setup/integration.setup.ts` (and transitively
`e2e.setup.ts`), so `test:integration`/`test:e2e` open a **second** pool
against the same role while `api-dev` (a `restart: unless-stopped` container)
is already holding its own pool open. B-038's 324 `P2024`s came from exactly
this: `connection_limit=10` in `.env.development` equaled the role's
`CONNECTION LIMIT 10` one-for-one, so `api-dev` alone could fill the entire
role budget with zero spare for a concurrent test run, ad hoc `psql`, or
`prisma migrate dev` — any one of which pushed the shared role past 10.
Fixed budget (decisions.md D-041): `connection_limit=4` in
`.env.development`/`.env.development.example`/`.env.example`. Worst case on
a busy box — `api-dev` (4) + one `test:integration` or `test:e2e` run (4,
same file) = 8 of 10, leaving 2 spare for a `psql`/`prisma migrate dev`
session. A genuine multi-agent pile-up (`api-dev` + two concurrent test
runs) can still exceed 10 — that is a real, documented limit of a `10`-wide
role fence shared across several always-on/on-demand consumers, not
something a bigger `connection_limit` number fixes; the fence exists
specifically so dev contention can never reach `eld_prod`'s budget, and it
is a hard rule (tz.md §22.3.4) that is not this fix's place to relax. A
dedicated load-testing window that needs closer to the §19 ingest targets
on dev should raise `eld_dev`'s `CONNECTION LIMIT` *temporarily* and pause
sibling test suites for that window, then revert — an operational call, not
a default committed to the repo.

| Consumer | Role | Pool size | Notes |
|---|---|---|---|
| `api` | `eld_prod` | 20 | `.env.production` |
| `worker` (all `src/workers/*.processor.ts`) | `eld_prod` | 20 | one shared `PrismaService` pool |
| **prod total** | `eld_prod` | **40 / 40** | = `CONNECTION LIMIT 40`, zero spare |
| `api-dev` | `eld_dev` | 4 | `.env.development` |
| `test:integration` / `test:e2e` (when run) | `eld_dev` | 4 | loads the same `.env.development` |
| ad hoc `psql` / `prisma migrate dev` | `eld_dev` | 1–2 | operator sessions |
| **dev worst-case (2 consumers)** | `eld_dev` | **8–10 / 10** | at `CONNECTION LIMIT 10` |
| `retention.processor` (`eld_retention_svc`) | `eld_retention_svc` | 2 | separate role, doesn't count against `eld_dev`/`eld_prod` |

## Secrets

Real credentials (DB passwords, JWT secrets, Firebase keys, Sentry DSNs,
MinIO keys) are never committed or baked into an image layer. They are
mounted/injected from the server's secrets folder into `.env.development`
and `.env.production` (copied from the `.example` templates in
`backend/`), which `docker-compose.yml` loads via `env_file`.

## 7-day HOS drift monitoring window (TS vs Dart) — tasks.md Phase 12

tz.md §8.6 point 5 requires the nightly server-vs-app HOS state comparison to run for a
sustained window with zero *unexplained* drift before sign-off. This section is the procedure;
the window itself takes 7 real days and has NOT been run yet as of Phase 12 (cannot elapse
inside one session) — `tasks.md` leaves that checkbox unticked deliberately.

**What already runs, unattended, once the worker container is up:**
- `HosDriftProcessor` (`src/workers/hos-drift.processor.ts`) self-schedules a repeatable BullMQ
  job at `20 3 * * *` UTC (`HOS_DRIFT_CRON`) — no manual trigger needed once `worker` is
  deployed with `NODE_ENV=production` against the real prod DB/Redis.
- Each run calls `HosDriftService.runNightlySweep()`, which pages every `DriverHosSnapshot`,
  re-derives the server's own HOS state and compares it with the last state the driver's Dart
  (mobile) engine reported. Any single-driver drift beyond 60s raises
  `HOS_ENGINE_DRIFT_ALERT` (`alert.hos_engine_drift`) *and* `SentryService.capture(...)`
  (`src/modules/hos-state/hos-state.service.ts`).
- `SentryService.capture()` increments `onebook_sentry_captures_total{fingerprint="hos_engine_drift"}`
  on the worker's own `/metrics` (`WORKER_HEALTH_PORT`, see Monitoring & alerts above) — this is
  the queryable signal for the window, independent of log-scraping.
- If the nightly job itself fails to run (crash, DB down, etc.), `HosDriftJobFailing`
  (`docker/prometheus/alerts.yml`) fires — a night with *no* data point is distinguishable from
  a night with zero drift.

**Running the window in a near-production setting:**
1. Deploy `worker` (compose service, `NODE_ENV=production`) against the real prod DB/Redis —
   not `api-dev`/dev-only — so the sweep runs against real `DriverHosSnapshot` rows written by
   actual mobile-engine traffic, matching §8.6's intent (a lab-only dev DB with synthetic data
   would not exercise real network/clock-skew conditions).
2. Confirm `onebook_hos_drift.processor` scheduled (`worker` container logs:
   "Nightly HOS drift sweep scheduled" at boot).
3. Let it run nightly, unattended, for 7 consecutive nights (7 data points at 03:20 UTC).
4. **How to read the result each morning:**
   - `docker compose logs worker | grep 'HOS engine drift sweep done'` — one structured line
     per night: `{scanned, compared, skippedVersion, drifted, failed}`.
   - `onebook_sentry_captures_total{fingerprint="hos_engine_drift"}` (Prometheus) — the counter
     should NOT increase on a clean night; any increase means at least one driver drifted
     beyond 60s that night, and the driver ids are in the same night's log line's associated
     `driverId` tags/`alert.hos_engine_drift` deliveries (§7.6 `raiseAlert`).
   - Every `drifted > 0` night must be individually investigated and either explained (e.g. a
     known clock-skew device, a driver who was offline and resynced) or treated as a real
     TS/Dart engine mismatch bug and fixed before sign-off — "zero unexplained drift" does not
     mean zero drift events, it means every drift event that did occur has a known, accepted
     cause.
5. Sign-off condition (tasks.md): 7 consecutive nightly runs complete (no `HosDriftJobFailing`
   nights) AND every `drifted > 0` night from step 4 has a recorded explanation.
6. Record the 7 nights' results (date, scanned/compared/drifted/failed, explanations for any
   drift) wherever this project tracks sign-off evidence, then tick the Phase 12 box.

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
