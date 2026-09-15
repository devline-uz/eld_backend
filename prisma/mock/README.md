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
