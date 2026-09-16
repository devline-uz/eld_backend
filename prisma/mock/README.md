# Mock data (dev DB only)

Realistic, disposable dataset layered on top of `prisma/seed.ts` (which stays untouched) so
every feature of the OneBook ELD panel and API can be exercised: 200 drivers, ~170 vehicles,
6 months of history (2026-03-14 -> now), across HOS, ingest, compliance, fleet, safety/comms
and reports.

## Layout

```
prisma/mock/
  context.ts              MockContext + MockRng (seeded PRNG) + clampToNow()
  index.ts                orchestrator / CLI entrypoint
  generators/
    core.ts               drivers, vehicles, trailers, devices, assignments, co-driver pairings
    users.ts               ...
    hos.ts
    ingest.ts
    compliance.ts
    fleet.ts
    safety-comms.ts
    reports.ts
```

## Running

```
npm run db:mock                # all generators, fixed order
npm run db:mock -- core hos    # only the named generators, in fixed pipeline order
npm run db:mock -- ingest      # a single non-core generator, alone — allowed as long as the
                                # mock core rows already exist in the DB (checked directly, not
                                # by requiring "core" on the same command line — see D-055)
```

`index.ts` loads `.env.development` itself and refuses to run unless `DATABASE_URL`'s database
name is exactly `onebook_eld_dev` — it will never touch `onebook_eld` (prod). Before running any
generator other than `core`, it checks the DB for existing mock core rows (`mock_*` drivers,
`M1...` vehicles, `MOCKPT30-*` devices) and errors with a clear message if they are missing —
it does NOT require `core` to be passed on the same command line, precisely so that a lone
`npm run db:mock -- ingest` never has to needlessly re-run `core` just to satisfy this guard.

Fixed order (a later generator's FKs depend on the earlier ones existing):

```
core -> users -> hos -> ingest -> compliance -> fleet -> safety-comms -> reports
```

## The `MockContext` contract

```ts
export interface MockContext {
  prisma: PrismaClient;
  rng: MockRng;          // next(), int(a,b), float(a,b), pick(arr), chance(p), shuffle(arr)
  carrierId: string;     // the existing seeded carrier ('carrier')
  from: Date;            // now - 6 months, start of day, carrier timezone
  to: Date;              // now (never later) — clamp every generated timestamp to this
  log: (msg: string) => void;
}
```

`buildContext()` (in `context.ts`) resolves `carrierId`/`from`/`to` from the live `Carrier` row
so the window always tracks the real "now" the orchestrator is run at. `clampToNow(date, ctx)` is
provided to enforce "no future timestamps, ever" (B-044) in one line.

Each generator module is:

```ts
export async function run(ctx: MockContext): Promise<Record<string, number>>
```

returning the row counts it created, e.g. `{ drivers: 200, vehicles: 170 }`.

## Mock identity — how to find your own rows for idempotent re-runs

- **Drivers:** `username` starts with `mock_`; `email` ends with `@mock.onebook.example`.
- **Vehicles:** `unitNumber` in the `M1001…` range.
- **Users:** `email` ends with `@mock.onebook.example`.
- **Everything else:** found transitively through those FKs (e.g. a mock driver's `DailyLog`
  rows), or — only when a table has no FK back to a mock driver/vehicle/user at all — by a text
  field containing the literal `[mock]` marker (`MOCK_TAG` in `context.ts`).
- Nothing outside this identity is ever touched or deleted: the existing seed data
  (Universal Logistics Inc., Sarah Chen, units 101-120, John Smith, etc.) is left exactly as-is.

## Generator rules

- Idempotent: delete your own mock rows first (via the identity above), then insert — UNLESS
  another generator's FKs may already point at your rows' ids (this is exactly `core`'s
  Driver/Vehicle/Trailer/Device: see the id-stability rule below). Leaf tables with no inbound
  FK (nothing else's schema points at their id) are always safe to delete-and-recreate.
- **ID stability:** if your rows are referenced by another generator's FKs, never delete and
  recreate them. UPSERT by natural unique key instead (`context.ts`'s `mockId(domain,
  naturalKey)` gives a deterministic UUID v5 for the `create` branch only — the `update` branch
  must never touch `id`, so a row that already exists keeps whatever id it already has, even a
  pre-existing random one). This is what lets a later generator's own rows never be orphaned by
  an earlier generator being re-run.
- Batch inserts with `createMany` in chunks of <=5000 rows; never N+1 insert loops over large sets.
- No future timestamps — always run through `clampToNow()` or equivalent.
- Disk budget: total DB growth across every generator must stay <=1.5 GB (the box has ~4 GB
  free). Estimate your row counts before inserting; report actual sizes with
  `pg_total_relation_size`.
- Never touch the Prisma schema/migrations. If something can't be represented, report it instead
  of working around it with a schema change.
- Read-only git only — never stash/reset/checkout/restore/clean.
- Never restart the API (:3002) or worker (:3012).

## Live simulator (`npm run db:mock:live`) — dev only

The dataset above is a snapshot: nothing new arrives after it is generated, so the Live Fleet map
and HOS clocks go stale within an hour. `prisma/mock/simulator/` keeps the mock fleet moving by
playing the **mobile app** for every eligible mock driver — a driver JWT and the real HTTP ingest
endpoints, never a direct table write — so validation, sequence ids, `hos.recalc`, malfunction
detection and the Socket.IO push are exercised exactly as in production (decisions.md D-082).

```
npm run db:mock:live                          # every 60 s until Ctrl-C / SIGTERM (clean stop)
npm run db:mock:live -- --once                # one tick, then exit
npm run db:mock:live -- --minutes=3           # run for 3 minutes, then exit
  --interval=60        seconds between ticks (>= 5)
  --max-drivers=60     cap on drivers driven per run; 0 = every eligible driver (~130). Units that
                       are already DRIVING are picked first, then ON_DUTY, then resting ones.
  --tempo=N            demo mode: every planned status duration is divided by N (duty changes N
                       times more often); motion, odometer and engine hours stay real-time.
  --api=URL            default http://127.0.0.1:3002/api (or env LIVE_SIM_API)
  --seed=N             PRNG seed for the state machine
```

Permanently on, in the background (single node process, so the pid file is the real one):

```
cd backend && setsid nohup node -r ts-node/register prisma/mock/simulator/index.ts \
  > /tmp/eld-live-sim.log 2>&1 & echo $! > /tmp/eld-live-sim.pid
kill -TERM "$(cat /tmp/eld-live-sim.pid)"     # stop: finishes the in-flight request, then exits
```

What it does, per tick, for each driver whose `mock_*` account is ACTIVE with an ACTIVE `M1…`
unit that has a paired `MOCKPT30-*` device (the same association `IngestService.resolveContext`
demands — anything else is refused by the API):

- **DRIVING:** advances the unit along a corridor from `hos-events.ts` at 50–68 mph and posts one
  `TelemetryPoint` (`POST /ingest/telemetry`) with raw metric values; odometer (raw km) and engine
  hours are strictly monotonic and continue from the newest `EldEvent`/`TelemetryPoint` already in
  the DB for that vehicle. Every 60 min of driving an intermediate log (type 2/1) is written.
- **ON_DUTY:** an engine-on, 0 mph point (the panel shows it as IDLE); engine/idle hours accrue.
- **OFF / SLEEPER:** nothing but the heartbeat below.
- **Duty changes** (`POST /ingest/events`, batch of 1–3 records, server-computed sequence id,
  checksum supplied): legs of 1–3.5 h driving, then a 30–45 min OFF break or a 15–45 min ON stop;
  <= 10.5 h drive / 13.5 h shift, then a 10–14 h OFF/SB rest with engine shutdown / power-up
  records (type 6). DRIVING and post-driving ON_DUTY are `recordOrigin 1`; OFF/SB/pre-trip ON are
  `recordOrigin 2` with an annotation. Coordinates are sent raw — the server coarsens them.
- **Device:** BLE `CONNECTED` once per run (`/ingest/ble-state`) and a `/ingest/device-status`
  heartbeat every 10 min per device (`storedEventsCount 0`) so `Device.lastSeenAt` stays inside
  the 30-minute "ELD offline" line.
- Timestamps are `Date.now()` at send time — never in the future, never > 10 min from the server
  clock. The driver token is minted locally with `JWT_SECRET` from `.env.development` (same
  claims as `TokenService.signDriverAccessToken`) because `/auth/login/driver` is limited to
  5/min per IP; `POST /api/auth/login/driver {username: "mock_…", password: "Onebook2026"}` would
  yield the identical token interactively.
- Event uuids start with `6c697665-` ("live"), deterministic per (driver, type, code, second) —
  a retried upload is a duplicate, not a second row. `EldEvent` is append-only, so a simulator
  run is permanent; `db:mock -- hos` REFRESH mode re-derives headers from all stored events.
- Rate: requests are paced evenly across the interval, so the fleet stays at about
  `max-drivers / interval` requests per second (1/s by default). The DB is read once at
  startup (`connection_limit=2`); the process holds no DB connection afterwards.

Known effects: the first `/ingest/events` per vehicle after a silent day trips the real §7.8
window checks (malfunctions `E`/`L`, diagnostic `2`) once — the device genuinely reported nothing
for 24 h. HOS clocks reflect the dataset's history: if a driver was left DRIVING at the snapshot
time a day ago, `driveRemainingSec` is 0 until `npm run db:mock -- hos` is re-run (then
`compliance`, D-070). Only vehicle rooms (`vehicle:{id}`) receive ingest pushes
(`telemetry.point`, `eld.events_ingested`, `device.ble_state`); `fleet` has no ingest publisher.
