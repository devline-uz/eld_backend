# OneBook ELD — Backend

NestJS 11 modular monolith. FMCSA 49 CFR §395 compliant ELD backend.
**Single source of truth: [`tz.md`](./tz.md).** Sequencing: [`tasks.md`](./tasks.md).

## Running

```bash
cp .env.example .env          # then fix DATABASE_URL / REDIS_URL
npm install
npm run prisma:generate       # required once a prisma/schema.prisma exists
npm run migrate:dev           # dev DB only — never on prod (TZ §22.3.3)
npm run db:seed
npm run start:dev             # API   → http://localhost:3000 , Swagger → /docs
npm run worker:dev            # BullMQ worker (separate process/container)
```

| Script | Purpose |
|---|---|
| `build` / `start:prod` / `worker:prod` | compiled entrypoints (`dist/main.js`, `dist/worker.js`) |
| `test` · `test:unit` · `test:integration` · `test:e2e` · `test:cov` | Jest projects (TZ §21) |
| `lint` | eslint, `--max-warnings 0`; also enforces the layering rules below |
| `migrate:dev` / `migrate:deploy` | dev creates migrations (guarded, see below), prod only applies them |
| `db:reset:dev` / `db:check-drift` | `scripts/*.sh`, owned by `eld-devops` |

### Hand-written partial / expression indexes

Some unique indexes can't be written in `schema.prisma` (partial `WHERE "deletedAt" IS NULL`
uniques, the trim/case-insensitive plate + state index) and live only in migration SQL. They are
listed in [`src/core/prisma/custom-indexes.ts`](./src/core/prisma/custom-indexes.ts), the single
whitelist. `npm run migrate:dev -- --name <change>` (`scripts/migrate-dev-guarded.ts`) generates the
next migration from the migration history + schema (shadow DB `<db>_shadow`, or
`SHADOW_DATABASE_URL`), strips any DROP/CREATE of a whitelisted index, writes nothing when no change
is left, and applies the rest with `migrate deploy`. Flags: `--create-only`, `--dry-run`. It only runs
against a local DB. `custom-indexes.spec.ts` fails if a committed migration drops a whitelisted index
without `-- custom-index: drop <name>`. Plain `prisma migrate dev` is `migrate:dev:unguarded`.
New hand-written index → its own migration + an entry in the whitelist.

Endpoints that exist today: `/health/live`, `/health/ready`, `/health/deep`, `/metrics`, `/docs`.

## Layering (TZ §3.5) — non-negotiable

```
*.controller.ts  →  *.service.ts  →  *.repository.ts
```

- Controllers hold **no** business logic — they parse, delegate, return.
- Repositories know **nothing** about HTTP.
- `prisma.*` is called **only** inside a `*.repository.ts`, and only through
  `BaseRepository` (TZ §27.1). The eslint config fails the build if a controller or
  service touches `prisma`.
- **Exception:** `src/modules/hos/` is pure functions — no DB, no Nest DI, no imports
  from `core/`. Enforced by a `no-restricted-imports` rule.

Other standing rules:

- Every DTO is a zod schema validated by `ZodValidationPipe` (TZ §6.5).
- Every error is thrown as `AppException` with a code from `common/errors/codes.ts`
  and rendered into the TZ §20 envelope (`statusCode`, `code`, `message`, `details`,
  `traceId`, `timestamp`). **Codes are append-only — never rename or delete one.**
- Unit conversion happens **only** in `common/units/` (TZ §4). The DB stores imperial;
  the metric value the device sent is preserved in `raw*` columns.
- `RequestContext` (AsyncLocalStorage) carries `requestId`/`traceId`/`user`/`carrierId`
  on every request and feeds the logger, the audit interceptor and the error envelope.
- Heavy work goes to BullMQ and runs in `worker.ts` — never in the API container (§3.3).
- SaaS insurance (TZ §27.1): all IDs are UUIDs, `Carrier` is a table, all DB access is
  through `BaseRepository`. Do **not** add `carrierId` columns yet (§27.3).

## Layout

```
src/
  main.ts            API entrypoint (helmet, CORS, Swagger /docs, graceful shutdown)
  worker.ts          BullMQ entrypoint — no HTTP listener
  app.module.ts      module tree per TZ §3.4 + global filter/guards/interceptors
  common/            decorators, guards, interceptors, filters, pipes, errors, units
  core/              config (+ db-guard), prisma, logger, queue, storage, firebase, events, context
  modules/           feature modules (health today; the other 25 land in Phases 2–11)
  workers/           BullMQ processors, loaded only by worker.ts
```

## Database safety (TZ §22.3)

`core/config/db-guard.ts` runs at AppModule bootstrap in **both** entrypoints and has no
off switch. It refuses to start when: the DB name is neither `onebook_eld` nor
`onebook_eld_dev`; a dev process points at the prod DB; a prod process points at the dev
DB; or a prod process connects as anything other than `eld_prod`.

## Testing gates (TZ §21)

| Scope | Threshold | Status |
|---|---|---|
| `src/common/units/**` | 100% | enforced, green |
| `src/modules/hos/**` | 95% | enforced, green |
| global | 80% | enforced; turns green as feature phases land their tests |

`npm test` runs unit tests only and needs no Postgres, Redis or MinIO.

## Conflict order

When documents disagree:

**FMCSA 49 CFR §395 > Pacific Track docs (`eld.docs/pt30_docs/`) > `tz.md` > Figma > existing code.**
