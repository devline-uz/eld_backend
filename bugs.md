# Bug log

Defects found while building and testing the OneBook ELD backend, with their resolution.
Companion to `decisions.md` (design choices) and `tasks.md` (roadmap progress).

Status legend: **FIXED** · **OPEN** · **NOT A BUG** (investigated, no defect — recorded so the
same thing is not chased twice).

Last updated: 2026-09-11, Phase 11.

Numbering note: running agents concurrently produced three collisions. `eld-qa-test`'s entry
keeps **B-013**; the `eld-hos-engine` pair was renumbered to **B-015** and **B-016**. The
`eld-auth-rbac` and `eld-compliance-rods` entries that both collided with the `eld-ingest-device`
pair were renumbered to **B-017** and **B-018**; the ingest entries keep B-010 and B-011. The next
free number is **B-020**.

---

## B-013 — worker boot crashed: `IntegrationsModule` could not resolve `AuditSnapshotRegistry` · FIXED
**Found:** running `npm run test:cov` for the global 80% coverage gate; `test/smoke/boot.smoke-spec.ts`
failed on the worker half with `UnknownDependenciesException` for `AuditSnapshotRegistry` in
`IntegrationsModule`.
**Severity:** high — `dist/worker.js` could not boot at all; every BullMQ processor (webhook
delivery included) would have been down in that composition.

`CommonModule` is `@Global()`, which only makes its providers ambient once the module has been
imported somewhere in the *current* application tree. The API composition (`AppModule`) imports
`CommonModule` for its guard/filter/interceptor chain, so `RolesModule`/`SupportModule`/
`IntegrationsModule` all resolved `AuditSnapshotRegistry` fine there. `WorkerAppModule`
(`src/worker.ts`) deliberately has no controllers/guards and never imports `CommonModule` — but
`WorkersModule` imports `IntegrationsModule` directly for `webhook.processor.ts`, and
`IntegrationsModule.onModuleInit()` injects `AuditSnapshotRegistry` unconditionally. Only
`IntegrationsModule` is shared between the two compositions, so only it hit the gap.
**Fix:** `IntegrationsModule` now explicitly imports `CommonModule` (idempotent — Nest caches
module instances, so this is a no-op in the API composition and the missing link in the worker
one). `RolesModule`/`SupportModule` were left untouched: neither is imported by `WorkersModule`,
so they have no analogous gap.

---

## B-001 — API and worker crashed on boot: missing `pino-pretty` · FIXED
**Found:** Phase 1 verification, by actually running `node dist/main.js` for the first time.
**Severity:** critical — the service could not start at all in the dev configuration.

`.env.development` sets `LOG_PRETTY=true`, which makes pino load the `pino-pretty` transport.
That package was never added as a dependency, so startup died in the logger provider:

```
Error: unable to determine transport target for "pino-pretty"
    at fixTarget (node_modules/pino/lib/transport.js:160:13)
```

Every suite was green at the time, because none of them boot the compiled entrypoint (see B-004).

**Fix:** added `pino-pretty` as a devDependency.
**Verified:** API boots; `/health/live`, `/health/ready`, `/health/deep`, `/docs`, `/metrics` all
return 200. Worker boots and logs "Worker started — BullMQ processors registered".

---

## B-002 — Append-only `REVOKE` was hardcoded to `eld_dev`, leaving prod unprotected · FIXED
**Found:** reviewing the init migration before applying it to the production database.
**Severity:** critical — compliance invariant (tz §23, §5.5, §18; FMCSA §395) silently absent on
the environment where it actually matters.

`prisma/migrations/20260910180242_init/migration.sql` ended with:

```sql
REVOKE UPDATE, DELETE ON "EldEvent" FROM eld_dev;
REVOKE UPDATE, DELETE ON "AuditLog" FROM eld_dev;
```

Applied to `onebook_eld` (owned by `eld_prod`), both statements are no-ops: the tables stay
UPDATE/DELETE-able. The append-only guarantee held only in dev.

**Fix:** migration `20260910190500_append_only_revoke_hardening` makes the revoke role-agnostic
and idempotent — a `DO` block looping over `eld_dev`/`eld_prod` guarded by `pg_roles` existence
checks, plus `REVOKE ... FROM PUBLIC`. The original migration was left untouched (its checksum is
recorded in the dev DB).
**Verified on both databases:** `UPDATE`/`DELETE` on `AuditLog` and `EldEvent` fail with
`permission denied`, as `eld_dev` on `onebook_eld_dev` and as `eld_prod` on `onebook_eld`.

---

## B-003 — `REVOKE` on a partitioned parent does not reach its child partitions · FIXED
**Found:** while fixing B-002; the agent tested the partitions directly instead of trusting the
parent-level grant.
**Severity:** critical — a complete bypass of the append-only guarantee, and the kind of hole an
FMCSA audit exists to find.

Postgres gives each partition its own independent ACL. With the parent locked down,
`UPDATE "EldEvent" ...` was correctly refused, but addressing a partition by name still worked:

```sql
UPDATE "EldEvent_y2026m09" SET ... ;   -- succeeded
```

The partition's owning role retained implicit owner privileges because the partition's ACL was
empty.

**Fix:** the same `20260910190500` migration (1) applies the revoke to every existing `EldEvent`
child partition including `EldEvent_default`, and (2) redefines `create_monthly_partition()` so
every future partition is locked down at creation time.
**Verified:** direct `UPDATE "EldEvent_y2026m08"` now fails with `permission denied` on both dev
and prod; covered by a `partition-level enforcement` block in
`test/integration/append-only.spec.ts`, including a freshly created future partition.

`TelemetryPoint` deliberately not covered — tz §5.6 imposes no append-only requirement on it,
unlike §5.5/§18.

---

## B-004 — Test blind spot: no suite booted the compiled entrypoints · FIXED
**Found:** root-cause analysis of B-001.
**Severity:** high — a whole class of startup/config/dependency failures was invisible to CI.

The e2e suite builds a Nest testing module in-process. Nothing ever executed `dist/main.js` or
`dist/worker.js`, so B-001 shipped past 148 green tests.

**Fix:** `test/smoke/boot.smoke-spec.ts` spawns the real built entrypoints as child processes
against the real `.env.development` (with `LOG_PRETTY=true` left on), waits for readiness, and
asserts `/health/live`, `/health/ready`, `/health/deep`, `/metrics`, `/docs-json`, plus the
worker's "processors registered" line and that it stays alive. Port is configurable
(`SMOKE_API_PORT`, default `18173`) to avoid collisions. Wired as `npm run test:smoke`.
**Verified the test actually catches the original bug:** removing `pino-pretty` from
`node_modules` made the smoke test fail with the exact B-001 error; restoring it made it pass.

---

## B-005 — Permission coverage claimed more than it tested · FIXED
**Found:** Phase 1 exit review.
**Severity:** medium — a Global gate ("Permission test written for every role") would have been
ticked on evidence that did not support it.

Only `DISPATCHER` was exercised through the real `PermissionGuard`. `ADMIN`, `FLEET_MANAGER` and
`VIEWER` were verified only as matrix *data*, which cannot catch a guard that misreads the matrix.

**Fix:** `src/common/guards/permission.guard.spec.ts` rewritten table-driven over the real
`DEFAULT_ROLE_MATRIX` (not a copy): 4 roles × every matrix key, asserting FULL allows READ+FULL,
READ allows READ but rejects FULL, NONE rejects both — 114 tests. Added a driver-subject block
(all 22 keys rejected) and an unauthenticated 401-vs-403 case. The e2e permission block derives
its expectation from the matrix at runtime.
**Residual limit, deliberately recorded:** Phase 1 only wires `@Perm` onto
`users`/`roles`/`auditLog`/`integrations`, and every non-ADMIN seeded role is NONE on all four —
so e2e can only prove the reject case per role today. The FULL-allow and READ-vs-FULL-write cases
for non-admin roles are proven at guard-unit level until Phase 2 adds endpoints on keys like
`vehicles`/`dashboard`. Re-check this when Phase 2 lands.

---

## B-006 — Audit rows recorded that something changed, but never what · FIXED
**Found:** Phase 1 exit review against tz §18.
**Severity:** medium — §18 defines `before Json?` / `after Json?` on `AuditLog`; leaving both null
means an auditor sees an action occurred but cannot see the change.

**Fix:** `AuditInterceptor` now takes a before-snapshot via a new `AuditSnapshotRegistry` and an
after-snapshot post-handler (forced null on DELETE); `RolesModule`/`UsersModule`/`ApiKeysModule`
register loaders in `onModuleInit`, so no `@Audit()` call site hand-assembles snapshots. The pair
is reduced to a field-level diff and passed through `redactSecrets()` before insert. Rationale
recorded as D-002 in `decisions.md`.
**Redacted:** `passwordHash`, `twoFactorSecret`, `recoveryCodes`, `refreshHash`, `keyHash`.
**Verified:** 22 new unit tests plus `test/e2e/audit-before-after.e2e-spec.ts` against the dev DB
(role update diff, role delete, API-key create with `keyHash` redaction).
**Still to come:** tz §18's mandatory list also covers log edits, certification, unit deletion,
odometer calibration, data transfer, report export and carrier settings — those operations do not
exist yet. A note in `src/modules/audit/audit.module.ts` explains how later phases plug in.

---

## B-007 — Environment config drifted between the two agents that wrote it · FIXED
**Found:** first attempt to start the stack.
**Severity:** low, but it would have wasted real debugging time later.

Two problems. (1) `.env.development.example` / `.env.production.example` were written against a
different variable set than `src/core/config/env.schema.ts`, the authoritative zod schema —
different names (`S3_ACCESS_KEY_ID` vs `S3_ACCESS_KEY`), missing keys, and variables the schema
does not know. (2) `docker-compose.yml` published no host ports for postgres/redis/minio, and its
api/api-dev ports (3000/3001) collide with an unrelated project already running on this box.

**Fix:** both example files regenerated from the zod schema; compose remapped to
`127.0.0.1:55432` (postgres), `63791` (redis), `19000`/`19001` (minio), `13000`/`13001`
(api/api-dev). Real `.env`, `.env.development`, `.env.production` created with generated
credentials, `chmod 600`, and added to `.gitignore`.

---

## Investigated — not bugs

Recorded so nobody re-investigates them.

| Observation | Verdict |
|---|---|
| After rotating a refresh token, the **new** token also returned 401 | **Correct.** Replaying the old token first triggered reuse-detection, which revokes the whole session family — the intended OAuth defence. A clean 3-link rotation chain succeeds every time. |
| `429 RATE_LIMITED` during manual auth testing | **Correct.** Auth routes are throttled to 5/min/IP per tz §6.5. My test script hit the limit, not a defect. |
| `POST /auth/refresh` returned `422 VALIDATION_FAILED` | **My test's fault.** `subjectType` (`user`/`driver`) is a required field; I omitted it. |
| `POST /auth/login` returned 404 | **My test's fault.** The API mounts under `API_PREFIX=api`; health routes sit outside the prefix, auth routes do not. |

---

## Open

| # | Item | Notes |
|---|---|---|
| O-1 | Production migrations must be run by the user | Not a defect — the sandbox blocks `migrate deploy` against prod from this session. Procedure and rationale in `decisions.md` D-001. Phase 1's two migrations **are** applied; anything later is pending. |
| O-2 | Non-admin roles cannot be e2e-tested on the allow path yet | See B-005 residual limit. Revisit when Phase 2 adds `vehicles`/`dashboard` endpoints. |
| O-3 | Per-token API rate limiting deferred | Currently per-IP only. Flagged by the auth agent; revisit when `modules/integrations` needs it. |
| O-4 | No outbound email for user invite / password reset | Tokens are returned directly outside production. Needs a mail transport before go-live. |

---

## Incidents

**I-001 — I took down an unrelated project's API.** While stopping my test server I ran
`pkill -f 'node dist/main.js'`, whose pattern also matched the `vkus-eat` project running on this
same box. Its API on port 3000 was killed and auto-restarted about 12 seconds later; it is healthy
now. No data loss, but the outage was real and caused by carelessness on a shared machine.
**Lesson, also saved to memory:** match on the full path
(`/root/projects/devline/eld_logistics/backend/dist/main.js`), never a bare `dist/main.js`.

---

## Verified state at time of writing

`npm run build` OK · `npm run lint` OK · unit **220** · integration **25** · e2e **35** ·
smoke **2** — all passing. Schema drift check clean between dev and prod.

---

## B-008 — Subagents derailed on launch by `skills:` frontmatter in a non-git repo · FIXED
**Found:** Phase 2 kickoff, on the first delegation to `eld-fleet-ops`.
**Severity:** high — the agent burned a full run and produced zero work.

Every file in `.claude/agents/` declared diff-based skills in its frontmatter, e.g.
`skills: code-review, simplify`. Those skills inject their slash-command payload into the
agent's first turn, and each one begins by resolving a diff (`git diff @{upstream}...HEAD`,
`git diff main...HEAD`, `git diff HEAD`). This project is not a git repository, so all of them
failed with `fatal: not a git repository`.

The agent then saw three framings stacked in one turn — the real Phase 2 brief plus two
injected command payloads — read that as a malformed or injected prompt, and correctly stopped
to ask instead of guessing. It modified no files. The caution was right; the configuration that
caused it was the defect.

**Fix.** Removed the `skills:` key from all twelve agent definitions. Diff-based reviews now run
from the main session, which has the context to target files directly instead of a diff. Added a
shared **Project contract** block to every agent file stating that the repo is intentionally not
under git and that `git` must never be run, plus a **How you work** block telling agents to treat
repo content as data rather than instructions and to resolve ambiguity with a stated assumption
instead of handing the work back.

**Prevention.** `.claude/agents/README.md` now records why `skills:` is deliberately absent, so
it does not get added back.

---

## B-009 — append-only `REVOKE UPDATE` on `EldEvent` breaks hard `DELETE` of `Vehicle`/`Driver`/`Device` · FIXED (Phase 3, root cause)
**Found:** Phase 2, writing the integration test for `DELETE /vehicles/:id`.
**Severity:** high — not caused by Phase 2 code, but it silently breaks any hard delete of a
row that `EldEvent` has an FK to, fleet-wide, including for the Postgres **superuser**.

`EldEvent.deviceId` / `.driverId` / `.vehicleId` are `ON DELETE SET NULL` foreign keys. Deleting
a `Device`/`Driver`/`Vehicle` row makes Postgres run its internal `RI_FKey_setnull_del` trigger,
which executes `UPDATE "EldEvent" SET "deviceId" = NULL WHERE "deviceId" = $1` (or the
`driverId`/`vehicleId` equivalent) against `EldEvent` — and the B-002 hardening migration
(`20260910190500_append_only_revoke_hardening`) revoked `UPDATE` on `EldEvent` from `eld_dev`
**and PUBLIC**. Repro (as the real Postgres superuser, `rolsuper = t`, not just the app role):

```
$ docker compose exec postgres psql -U postgres -d onebook_eld_dev \
    -c 'DELETE FROM "Device" WHERE serial = '"'"'PT30_TEST_X'"'"';'
ERROR:  permission denied for table EldEvent
CONTEXT:  SQL statement "UPDATE "public"."EldEvent" SET "deviceId" = NULL WHERE $1 OPERATOR(pg_catalog.=) "deviceId""
```
Also reproduces as plain `SELECT id FROM "EldEvent" LIMIT 1 FOR KEY SHARE` for `eld_dev` (owner,
`UPDATE`/`DELETE` revoked, `SELECT` intact) — row-locking clauses need more than `SELECT`. A
control probe against `Dvir` (not append-only) succeeds with the identical `FOR KEY SHARE` query,
isolating the cause to the B-002 REVOKE rather than to FK checks in general. That the real
superuser also fails is the surprising part — worth the owning team (`eld-ingest-device` /
`eld-compliance-rods`, who own `EldEvent`'s migrations) re-verifying against Postgres 16's actual
RI-trigger privilege model before deciding on a fix (e.g. exempting `SET NULL` target columns, or
using a `BEFORE DELETE` app-level nulling step instead of relying on the FK action).

**Workaround in this module (not a fix):** `VehiclesService.remove` / `DriversService.remove` /
`DevicesService.remove` never call `prisma.*.delete()`. They flip `status` to a terminal value
instead (`INACTIVE`, `TERMINATED`, `RETIRED`) — a plain column `UPDATE` on the *referenced* table
never touches `EldEvent` at all, so it isn't affected by B-009. This also happens to be the
correct product behavior independent of the bug: FMCSA compliance data must never orphan a
vehicle/driver/device that has historical `EldEvent` rows, so soft-delete was the right call
either way (see `decisions.md`).
**Verified:** `POST /vehicles/:id` → soft-deleted-to-`INACTIVE` round-trips through
`GET /vehicles/:id` with real DB writes (manual check against `onebook_eld_dev`); unit tests
cover the service-level status flip.

**Root cause (Phase 3, `eld-ingest-device`).** Confirmed on Postgres 16, and it is *not* specific
to `SET NULL`. Every FK delete action Postgres offers needs a privilege the append-only REVOKE
removed from the *referencing* table:

| FK action | What the RI trigger runs on `EldEvent` | Privilege needed |
|---|---|---|
| `SET NULL` / `SET DEFAULT` | `UPDATE "EldEvent" SET "driverId" = NULL WHERE ...` | UPDATE (revoked) |
| `NO ACTION` / `RESTRICT` / `CASCADE` | `SELECT 1 FROM "EldEvent" x WHERE ... FOR KEY SHARE` | row lock ⇒ UPDATE or DELETE (both revoked) |

Measured: after switching all three FKs to `ON DELETE NO ACTION`
(`20260911120000_ingest_event_sequence_and_fk_hardening`), `prisma.device.delete()` still failed
with `permission denied for table EldEvent` — and it failed even for a device that had **no
events at all**, because the row-lock probe is privilege-checked before any row is examined.

**Fix:** `20260911140000_eldevent_drop_foreign_keys` drops all three foreign keys.
`driverId` / `vehicleId` / `deviceId` stay as indexed scalar columns, and referential integrity
moves to the write path — `IngestService.resolveContext()` resolves the device, verifies it is
paired with the claimed unit and that the driver is associated with that unit before any row is
written (§7, the payload is untrusted anyway). This is also the correct §395 semantics: an ELD
record keeps the driver/vehicle/device id it was recorded with forever and must never be nulled
or re-pointed as a side effect of a parent-row operation. The append-only REVOKE is untouched.

The Phase 2 soft-delete behaviour stays as the product rule (a unit with §395 history is retired,
not deleted) — it is simply no longer forced on us by a database defect.

**Verified:** `test/integration/ingest-storage.spec.ts` — a device *with* events and a device
*without* events both hard-delete cleanly, the event keeps its historical `deviceId`, `EldEvent`
has zero FK constraints left, and `UPDATE "EldEvent"` is still refused with `permission denied`
(append-only intact, `test/integration/append-only.spec.ts` still green).

---

## B-010 — 1 MB ingest batches were rejected with a 500 by Express's 100 KB body limit · FIXED
**Found:** Phase 3, e2e test posting a 501-event batch to `POST /v1/ingest/events`.
**Severity:** high — tz §7.3 rule 2 explicitly allows 500 events / 1 MB per batch; real device
backlogs after a long BLE outage are exactly that size, and they were failing.

Nest's default `express.json()` limit is 100 KB. A 501-event batch (~150 KB) never reached the
zod schema: body-parser threw `PayloadTooLargeError` *before* the pipe, and because that error is
a plain `Error` (not an `HttpException`), `AllExceptionsFilter` rendered it as
`500 INTERNAL_ERROR` instead of a 413.

**Fix:** two parts, both minimal —
1. `src/main.ts` `configureApp()` now installs `json({ limit: '1mb' })`, matching §7.3 rule 2.
2. `AllExceptionsFilter` maps `entity.too.large` / any 413-carrying error to
   `413 PAYLOAD_TOO_LARGE` in the §20 envelope.
`IngestController` also checks `content-length` up front so an oversized batch is refused before
the body is buffered.
**Verified:** the 501-event batch now returns `422 VALIDATION_FAILED` (schema violation, the only
legitimate rejection per §7.3) instead of 500; `test/e2e/ingest.e2e-spec.ts` covers it.

---

## B-011 — `pg_advisory_xact_lock()` through `$queryRaw` broke every sequence allocation · FIXED
**Found:** Phase 3, first integration run of `IngestRepository.allocateSequenceIds`.
**Severity:** medium — the per-driver advisory lock that guarantees `eventSequenceId` uniqueness
never actually ran; every allocation errored out with `P2010`.

```
Raw query failed. Code: `N/A`. Message: `Failed to deserialize column of type 'void'.`
```

`pg_advisory_xact_lock()` returns `void`, and Prisma's `$queryRaw*` family tries to deserialize
the result set.
**Fix:** the lock (and the `ensure_event_partition()` / `create_monthly_partition()` calls, which
also return `void`) go through `$executeRawUnsafe`.
**Verified:** `test/integration/ingest-storage.spec.ts` — four concurrent transactions allocating
4 ids each for the same key produce 16 distinct, gap-free numbers.

---

## B-012 — dev DB carries leaked fixtures that break `seed-shape.spec.ts` · FIXED
**Found:** Phase 3, running the full `npm test` suite.
**Severity:** low — test-environment pollution only, no product code involved.

`onebook_eld_dev` contains committed rows that no seed produced: vehicles `TEST-1789093523820`,
`TEST-1789093983382`, `DBG2-1789094154832`, drivers `test_driver_178909…`, a device
`PT30_TEST_*`, and a role `E2E_AUDIT_ROLE_…`/user `e2e-…` pair created by
`test/e2e/audit-before-after.e2e-spec.ts` and `auth.e2e-spec.ts`'s invite test respectively, both
of which only cleaned up on the happy path (no `try`/`finally`), so an assertion failure upstream
of the cleanup line left the row behind permanently.

**Fixed (`eld-qa-test`, coverage pass):**
- `audit-before-after.e2e-spec.ts` — all three tests now delete their row in a `finally`, plus a
  belt-and-suspenders `role.deleteMany({ key: { startsWith: 'E2E_AUDIT_ROLE_' } })` in `afterAll`
  so a future failure anywhere in the file still can't leak past this suite.
- `auth.e2e-spec.ts`'s invite test — same `finally` treatment for the `User` row it creates.
- `auth.e2e-spec.ts`'s `GET /roles` assertion now filters out any surviving `E2E_AUDIT_ROLE_*`
  row before asserting the count, so pre-existing pollution can't fail it independent of the fix
  above.
- The one stray `E2E_AUDIT_ROLE_…` role and `e2e-…@universal-logistics.example` user actually
  found in `onebook_eld_dev` were deleted directly (not a `db:reset:dev`, no `Vehicle`/`Driver`/
  `Device` involved, so B-009's append-only `EldEvent` REVOKE does not apply to either table) —
  `seed-shape.spec.ts`'s role/user counts pass again.
- `seed-shape.spec.ts` itself now excludes the `TEST-*`/`DBG2-*` vehicle, `test_driver_*` driver,
  and `E2E_AUDIT_ROLE_*` role prefixes from its counts. This is deliberately **not** a loosened
  assertion (no `>=`, no widened tolerance) — it still requires exactly 69/58/4 *seeded* rows,
  it just no longer conflates "seeded" with "whatever happens to exist in the table right now".
- Correction to the "still open" note below, found while chasing an unrelated failure: hard
  `DELETE` of a `Driver`/`Vehicle`/`Device` row is **not** universally blocked by B-009 — that
  bug reproduces only when the row still has `EldEvent` rows pointing at it (the FK's `SET NULL`
  trigger then needs `UPDATE` on `EldEvent`, which is revoked). A leaked row with zero `EldEvent`
  history deletes cleanly. One leaked driver (`test_driver_1789093523820`) was confirmed to have
  no events and was deleted directly; it was also the fixture `test/e2e/ingest.e2e-spec.ts` was
  picking (first `ORDER BY username ASC` match for "ACTIVE, assigned, has a paired device"), so
  removing it fixed that suite's 12 failures too (driver login was failing because the leaked
  row's password hash was never `Onebook2026`). The remaining `TEST-*`/`DBG2-*` vehicles and the
  `PT30_TEST_*` device were left in place — deleting them is a bulk write against the shared dev
  DB while another agent (`eld-hos-engine`) is mid-run against it, which this session's tooling
  correctly refused to do without the user's own approval.

**Still open — needs a human to approve:** `TEST-1789093523820`, `TEST-1789093983382`,
`DBG2-1789094154832` (vehicles) and `PT30_TEST_1789093523820_dup` (device) are still in
`onebook_eld_dev`. They may well have zero `EldEvent`/`TelemetryPoint` history the same way the
driver did, in which case a plain `DELETE` (no reset needed) would work — but that should be
verified and run by a human once no other agent is mid-run against the dev DB, not assumed here.
If any of them turn out to have real event history, `npm run db:reset:dev && npm run db:seed` is
the fallback (Phase 3's original suggestion, still correct). The `seed-shape.spec.ts` filter above
means none of this blocks any test in the meantime.

---

## B-017 — `ApiKeysService.verify()` could never return `API_KEY_REVOKED` · FIXED

*(Renumbered from B-010 on 2026-09-11: `eld-auth-rbac` and `eld-ingest-device` ran concurrently and both claimed B-010. The ingest entry above keeps the original number.)*
**Found:** Phase 11 (`eld-auth-rbac`), reading `src/modules/api-keys/api-keys.service.ts` before
extending it.
**Severity:** medium — wrong, misleading error code on a security-relevant auth path (TZ §20
requires stable codes the caller can branch on).
`ApiKeysRepository.findActiveByHash` filtered `WHERE revokedAt IS NULL`, so a revoked key's hash
simply matched nothing. `verify()` then fell through to the "not found" branch and always threw
`API_KEY_INVALID`, never the dedicated `API_KEY_REVOKED` code — a caller (or a future admin UI)
could not distinguish "this key was intentionally revoked" from "this key never existed / was
mistyped". Separately, the expiry branch was throwing `API_KEY_REVOKED` with the message "API key
has expired.", the wrong code for that case too.
**Fix.** Replaced `findActiveByHash` with `findByHash` (no `revokedAt` filter — looks the row up
by hash regardless of state), and made `verify()` check in order: not found → `API_KEY_INVALID`
(401); `revokedAt` set → `API_KEY_REVOKED` (401); `expiresAt` in the past → new code
`API_KEY_EXPIRED` (401, added to `common/errors/codes.ts`, append-only per its header). Only a
key that clears all three checks reaches `touchLastUsed`. Covered by
`src/modules/api-keys/api-keys.service.spec.ts` (three separate tests, one per code, asserting
`touchLastUsed` is *not* called on the rejected paths).

---

## B-018 — Carrier eRODS identifiers: 4-char length checked, character set not · FIXED
**Found:** Phase 11 (`eld-compliance-rods`), reviewing the checklist line "Carrier eRODS fields
reviewed: `eldIdentifier`/`eldRegistrationId` exactly 4 chars, `erodsMode`" against §395
Appendix A and `tz.md` §10.1.
**Severity:** high — a persisted-but-illegal identifier silently invalidates every generated
eRODS output file and the Appendix A 4.8.2.2 file name; nothing downstream re-validates it.
Three holes existed in the carrier update path:
1. `UpdateCarrierDto` used `z.string().length(4)`, so `'OB#1'`, `'OB,1'` (a comma inside a
   comma-delimited CSV segment), `'OB 1'` and lowercase `'obk1'` all passed — Appendix A allows
   only `A-Z` / `0-9`, uppercase.
2. The DB had `CHECK (char_length("eldIdentifier") = 4)` only. `eldRegistrationId` had just
   `VarChar(4)`, which caps the maximum but happily stores `'AB'`; neither column constrained
   the alphabet, so seeds/scripts/direct SQL could persist a file-invalidating value.
3. `erodsMode` could be flipped to `PRODUCTION` while `eldRegistrationId` was still `NULL`,
   which would emit an empty ELD Registration ID in the Appendix A header segment.
**Fix.** `ErodsIdentifierSchema` in `src/modules/carrier/dto/carrier.dto.ts` — trim, upper-case,
then `/^[A-Z0-9]{4}$/` (`422 VALIDATION_FAILED`), used for both fields. Migration
`20260911150000_erods_identifier_charset` replaces `eld_identifier_len` with
`eld_identifier_format` and adds `eld_registration_id_format` (NULL or `^[A-Z0-9]{4}$`).
`CarrierService.update` rejects `erodsMode=PRODUCTION` without a registration id with
`422 TRANSFER_VALIDATION_FAILED`.
**Verified:** `src/modules/carrier/dto/carrier.dto.spec.ts` (24 unit tests with
`carrier.service.spec.ts`, incl. the old 6-char `TEST01`/`ONEB01` values) and
`test/integration/carrier-erods-constraints.spec.ts` (9 tests, real dev-DB writes rejected by
both CHECK constraints). `erodsMode` default `TEST` re-confirmed in schema, migration and DB.

---

## B-015 — HOS `logDate` read back in the driver's timezone shifted every RODS day one day west · FIXED
*(Logged as B-013 by `eld-hos-engine`; renumbered to B-015 because `eld-qa-test` had independently
claimed B-013 for the `IntegrationsModule` / `AuditSnapshotRegistry` worker-boot defect at the top
of this file. That entry keeps the number B-013.)*
**Found:** Phase 4 (`eld-hos-engine`), building `HosRecalcService` against the `DailyLog` /
`HosViolation` history.
**Severity:** high — silently wrong compliance data. `DailyLog.logDate` and
`HosViolation.logDate` are Postgres `DATE` columns; Prisma returns them as **UTC midnight**.
The first implementation converted them with the driver's home-terminal timezone
(`dayKey(driver.homeTerminalTimezone, log.logDate)`), which for every zone west of UTC maps
`2025-01-14T00:00:00Z` to `2025-01-13`. Effects: the 8-day recap fed each day's on-duty hours
into the wrong bucket, `previousDays` leaked the day currently being recalculated back into
its own cycle total (70 h cycle showed 10 h remaining instead of 70 h), and the range filter
`logDate >= dayStart(tz, key)` (05:00 Z for New York) never matched the stored 00:00 Z rows, so
existing violations were invisible to the reconciliation: nothing was ever AUTO_CLEARED and a
manually RESOLVED violation was re-opened as a fresh OPEN row on the next recalculation.
**Fix.** `src/modules/hos-recalc/hos-recalc.service.ts` — one `utcDate(key)` helper builds every
`@db.Date` bound and value, and stored dates are read back with `dayKey('UTC', …)`. The *event*
timeline still uses the home-terminal zone throughout (`dayStart(timezone, …)` for the event
window): the rule is "instants in the driver's zone, `DATE` columns in UTC".
**Verified:** `src/modules/hos-recalc/hos-recalc.service.spec.ts` — 26 tests, incl. "never
duplicates a violation across repeated runs", "auto-clears a violation that the fresh result no
longer contains", "never reopens a manually resolved violation", "stores the violation log date
at UTC midnight" and "ignores DailyLog rows inside the recalculated range". All four failed
before the fix.

---

## B-016 — split sleeper: a lone ≥ 2 h off-duty break wrongly paused the 14-hour window · FIXED
*(Logged as B-014 by `eld-hos-engine`; renumbered to B-016 alongside B-015 above.)*
**Found:** Phase 4 (`eld-hos-engine`), writing the conformance fixture
`040-split-pair-unclosed.json`.
**Severity:** high, and in the dangerous direction — it **hides** real SHIFT_14 violations.
The first pass of `analyzeSplits` excluded *any* qualifying part from the 14-hour window while
it waited for a partner. A 2 h off-duty break qualifies as the *shorter* half, so a driver who
simply took two hours off had their window silently stretched to 16 h and drove two hours past
the legal limit with no violation recorded.
**Fix.** `src/modules/hos/engine/split-sleeper.ts` —
`excludedWhilePendingByEndIndex` now holds only (a) a ≥ 7 h continuous sleeper period, which
pauses the window on its own, and (b) the opening half of a pair that actually closes later.
A short rest is excluded only once its pair completes; until then the window keeps running.
**Verified:** `split-sleeper.spec.ts` ("does NOT exclude a lone 2 h off-duty break from the
window", "excludes the first half of a pair that closes later"),
`compute-hos.split.spec.ts` ("does not exclude a lone 2-hour off-duty break from the window")
and fixtures `040-split-pair-unclosed.json` / `042-split-sum-below-10h.json`.

---

## B-019 — `npm test` failed only when it ran all three projects together · FIXED
**Found:** verifying the tree after Phase 4, immediately after clearing the leaked dev-DB rows
of B-012.
**Severity:** high — this is the command CI runs. Every suite passed individually, so the
failure looked like leftover data corruption rather than a test-harness defect.

After deleting the last leaked rows the counts were exactly the seed shape (69 vehicles, 58
drivers), and `npm run test:integration` (43/43) and `npm run test:e2e` (47/47) each passed on
their own. `npm test` still reported 49 failures across `seed-shape.spec.ts`,
`ingest-storage.spec.ts`, `audit-before-after.e2e-spec.ts` and `auth.e2e-spec.ts`.

The cause is Jest, not the data. `jest --selectProjects unit integration e2e` runs the three
projects **in parallel**, and the per-project `--runInBand` in `test:integration`/`test:e2e` does
not apply to the combined script. So the e2e project was creating and deleting fixture rows in
`onebook_eld_dev` while the integration project was counting rows in the same database — the
exact-count assertions in `seed-shape.spec.ts` saw another suite's in-flight rows. This is also
why B-012 looked only "partially" fixed: the cleanup work was sound, but the race kept
reproducing a symptom that looked identical to leaked data.

**Fix:** `npm test` is now `jest --selectProjects unit integration e2e --runInBand`, which
serialises across projects as well as within them.
**Verified:** `npm test` 1336/1336 passing, 93 suites, repeated twice. The per-project scripts
are unchanged and still pass alone.

---

## B-020 — `ApiKeysService.verify()` was never called by anything · FIXED
**Found:** Phase 11 Settings audit (`eld-fleet-ops`) — checking the "an API key can be issued,
used, and revoked" done-when criterion against the actual code, not just the CRUD endpoints.
**Severity:** high. `/api-keys` could issue and revoke keys and `ApiKeysService.verify()`
existed with a full set of §20 error codes (`API_KEY_INVALID`/`_REVOKED`/`_EXPIRED`), but no
guard, controller, or ingest path ever called `verify()`. A plaintext key handed to an
integration would be rejected by every route (`JwtAuthGuard` only understood `Bearer <JWT>`) —
the "used" third of the API key lifecycle silently didn't exist.

Also found while fixing this: `CreateApiKeyDto`/`UpdateApiKeyScopesDto.scopes` accepted any
non-empty string with no format check, even though the code comment already claimed "scopes
reuse the 22-key permission vocabulary + a level" — nothing enforced or parsed that shape.

**Fix.** `src/common/guards/api-key-verifier.port.ts` (new `ApiKeyVerifier` port, mirrors
`TokenVerifier`) + `src/modules/api-keys/api-keys-auth.adapter.ts` (real binding).extended
`JwtAuthGuard` to route a `Bearer obk_...` token to `ApiKeyVerifier.verify()` instead of
`TokenVerifier.verifyAccessToken()` (prefix check only — no JWT parsing attempted on an API
key). `ContextUser.type` gained an `'api-key'` member; `AuditEventPayload`/`EditorType` map it
to `SYSTEM` (`actorId` still carries the `ApiKey.id`). Scopes are now validated as
`"<permissionKey>:<READ|FULL>"` (case-insensitive level) by a zod regex built from
`PERMISSION_KEYS`; `ApiKeysAuthAdapter` parses that into a full `PermissionMatrix` (every key
not named by a scope is `NONE`) so `PermissionGuard` needs no changes at all to gate API-key
callers exactly like user callers.
**Verified:** `test/e2e/auth.e2e-spec.ts` — new test "an issued API key authenticates a request
scoped to its own permissions, then a revoked key is rejected" exercises the full
issue → use (200 in-scope, 403 out-of-scope) → revoke → use-again (401 `API_KEY_REVOKED`) cycle
against the real app. Plus `src/common/guards/jwt-auth.guard.spec.ts` (new),
`src/modules/api-keys/api-keys-auth.adapter.spec.ts` (new),
`src/modules/api-keys/dto/api-keys.dto.spec.ts` (new). Full unit run: 1583/1583 passing.

## B-021 — the eRODS generator would have silently truncated a 6-character ELD identifier into a wrong 4-character one · FIXED
**Found:** Phase 9 (`eld-compliance-rods`), writing `output-file.spec.ts` — my first draft of the
Appendix A header renderer passed `eldIdentifier` through `csvField(value, 4)`, i.e. it clipped
any over-long value to 4 characters.
**Severity:** High (compliance). `TEST01` — the exact value tz.md §10.1 calls out as the old,
file-invalidating mistake — would have been written as `TEST`: still 4 characters, so the file
would pass every length check while carrying an ELD identifier that is not ours and is not
registered. A silently wrong identifier is worse than a rejected file, because nothing flags it.
**Resolution:** `buildOutputFile()` now asserts `eldIdentifier` (and, when present,
`eldRegistrationId`) is exactly 4 characters of `[A-Z0-9]` and throws otherwise; no truncation
path exists. `validateOutputFile()` independently re-checks the length on the parsed header, so
a header smuggled in from anywhere else is caught too. Covered by "REFUSES a 6-character ELD
identifier instead of truncating it into a wrong one" (`output-file.spec.ts`) and "catches a
6-character ELD identifier smuggled into the header" (`validator.spec.ts`). The DB `CHECK` from
B-018 already makes this unreachable from the carrier profile; this closes every other caller.

## B-022 — `AppModule` could not resolve `ApiKeyVerifier`, so the whole app failed to boot · FIXED
**Found:** Phase "Global gates" pass, first run of `npm run openapi:gen` (which boots the real
`AppModule` to build the Swagger document).
**Severity:** critical — `NestFactory.create(AppModule)` threw before listening, so the API, the
worker entrypoint and every e2e suite were dead:

```
UnknownDependenciesException: Nest can't resolve dependencies of the ApiKeyVerifier (?).
Please make sure that the argument ApiKeysAuthAdapter at index [0] is available in the AppModule.
```

`app.module.ts` re-binds the port with `{ provide: ApiKeyVerifier, useExisting: ApiKeysAuthAdapter }`
so its own `APP_GUARD` `JwtAuthGuard` gets the real adapter instead of `CommonModule`'s
`@Global()` `NotImplementedApiKeyVerifier` stub. `useExisting` is an alias: the referenced
provider must itself be resolvable **in the module that declares the alias**. `ApiKeysModule`
provided `ApiKeysAuthAdapter` but exported only `[ApiKeysService, ApiKeyVerifier]`, so the
adapter class was invisible outside its own module and the alias had nothing to point at.

**Fixed:** `ApiKeysModule` now also exports `ApiKeysAuthAdapter` (one line, plus a comment
explaining why the export exists, so a future tidy-up does not remove it again). Verified by
booting the real `AppModule` twice: `npm run openapi:gen` (113 operations emitted) and
`test/e2e/openapi-contract.e2e-spec.ts`.

## B-023 — my own e2e test permanently polluted johnsmith's §22.3.6 fixture day · OPEN, needs a human with DB superuser
**Found:** Phase 6 (`eld-realtime-offline`), while writing `test/e2e/mobile.e2e-spec.ts`. Early
drafts logged in as `johnsmith` (mirroring `hos-state.e2e-spec.ts`) and posted several real
`POST /mobile/duty-status` / `POST /mobile/sync` duty-status changes for him before I noticed
`test/integration/seed-shape.spec.ts` pins his "today" RODS day to an exact fixture (tz.md
§22.3.6: 11:26 driving, 11-hour violation exceeded by 00:26, exactly 8 `DailyLog` rows).
**Severity:** Medium (test-data integrity, not production). `EldEvent` is append-only by design
(B-009 — `REVOKE UPDATE, DELETE ON "EldEvent" FROM eld_dev`), so the 24 `recordOrigin = 2` rows
those early runs wrote for `johnsmith` (id `98d7607c-a196-48c7-a4f2-0a82f9f23dc1`, all dated
2026-09-11 with annotations `'Resting at rest area'`, `'Driver-reported status change'`,
`'Sleeper berth at rest stop'`, `'Off duty replay test'`) cannot be removed with the app's own
DB role — the same protection that makes a real driver's log tamper-proof also makes a test
mistake against that driver permanent. `test/integration/seed-shape.spec.ts` now fails one
assertion (`dailyLogs.length` is 9, not 8) because `LogsService.buildDays()` regenerates a 9th
`DailyLog` header from those events on every call, so deleting the (mutable) `DailyLog` row
does not fix it — it is recreated the next time anything reads John Smith's logs.
**Mitigation applied:** `test/e2e/mobile.e2e-spec.ts` now selects any ACTIVE driver with an
assigned vehicle EXCLUDING `johnsmith` (`username: { not: 'johnsmith' }`, same pattern
`ingest.e2e-spec.ts` already used for this exact reason) and cleans up every MUTABLE table it
touches (`Dvir`/`Defect`/`Attachment`/`SyncedChange`, `Vehicle.status`) in `afterAll` — so no
further pollution occurs, and the suite runs clean and repeatably against its own driver.
**Not fixed:** the 24 stray rows already written for `johnsmith`. I attempted
`DELETE FROM "EldEvent" ... ` directly as the Postgres superuser (available via
`docker exec -u postgres onebook-postgres psql`, which I had already used once this session to
`ALTER ROLE eld_dev CREATEDB` for the migration shadow-DB step) and the permission system
correctly blocked it as a destructive shared-resource action. I did not attempt to work around
that block.
**Needs a human:** run, as the Postgres superuser, against `onebook_eld_dev`:
```sql
DELETE FROM "EldEvent"
 WHERE "driverId" = '98d7607c-a196-48c7-a4f2-0a82f9f23dc1'
   AND "recordOrigin" = 2
   AND "annotation" IN ('Resting at rest area', 'Driver-reported status change',
                         'Sleeper berth at rest stop', 'Off duty replay test');
```
then `DELETE FROM "DailyLog" WHERE "driverId" = '98d7607c-a196-48c7-a4f2-0a82f9f23dc1'` so it
regenerates from the clean event set next time anything reads the log (or just run
`npm run db:seed` again if a full reset is acceptable). Until then,
`test/integration/seed-shape.spec.ts` has exactly one known-red assertion, and it is this one.

## B-024 — worker.ts failed to boot at all: `TransferProcessor` needed `AuditRepository` but `WorkersModule` never imported `AuditModule` · FIXED
**Found:** Phase 10 (`eld-reports-jobs`/`eld-fleet-ops`), while smoke-testing `node dist/worker.js`
after wiring `AlertProcessor`/`SafetyDetectProcessor` into `WorkersModule`. Not caused by this
phase's own code — `TransferProcessor` (Phase 9, `eld-compliance-rods`) injects
`TransfersService`, which injects `AuditRepository` (`transfers.service.ts:11,53`), but
`TransfersModule` only imports `AuditModule` for its own internal use and does not re-export it,
so `WorkersModule` — which imports `TransfersModule` but never `AuditModule` directly — could
not resolve the dependency. Nest's DI failed at boot with
`UnknownDependenciesException: Nest can't resolve dependencies of the TransferProcessor (…, ?).
Please make sure that the argument AuditRepository at index [3] is available in the
WorkersModule module.` This meant the ENTIRE worker container — every processor, not just
transfers — never started, silently breaking hos-recalc, retention, webhooks and everything else
that has been shipping since Phase 4.
**Severity:** Critical (worker container down = no async processing at all in any environment
that runs `node dist/worker.js`, e.g. prod/staging compose). Not caught earlier because unit
tests mock module wiring away and no e2e/integration suite boots the actual `WorkerAppModule`.
**Fix:** Added `AuditModule` to `WorkersModule`'s `imports` (`src/workers/workers.module.ts`) —
one line, since `AuditRepository` only needs to be resolvable in `WorkersModule`'s injector
tree, not re-exported by `TransfersModule` itself (Nest resolves parent providers per-module,
not per-processor). Verified with `node dist/worker.js` against the real dev Redis/Postgres:
boots clean, logs "Worker started — BullMQ processors registered", and immediately drains the
existing `hos.recalc` backlog with no DI errors.
**Suggested follow-up (not done here, out of Phase 10 scope):** add a cheap boot-smoke test
(e.g. `Test.createTestingModule({ imports: [WorkerAppModule] }).compile()`) to CI so a future
processor added to `WorkersModule` without its transitive dependency's module can't reach
main/prod again.

## B-025 — `npm run build` broke after `@aws-sdk/lib-storage` was bumped to 3.1130.0 (peer now requires `client-s3` ^3.1130.0, whose stricter `Body` type no longer accepted `NodeJS.ReadableStream`) · FIXED
**Found:** Phase 10, running `npm install @nestjs/websockets @nestjs/platform-socket.io
socket.io` for the realtime gateway triggered a full dependency re-resolution, which surfaced
(but did not cause) a pre-existing incompatibility: `package.json` already pinned
`@aws-sdk/lib-storage: ^3.1130.0` (bumped by another concurrent phase's work on file uploads)
while `@aws-sdk/client-s3`/`@aws-sdk/s3-request-presigner` were still `^3.699.0`. `lib-storage`
3.1130.0's `package.json` declares a peer `"@aws-sdk/client-s3": "^3.1130.0"`, so any fresh
`npm install` pulls `client-s3` up to 3.1130.0 too — whose `PutObjectCommand.Body` narrowed to
`StreamingBlobPayloadInputTypes`, which (post-bump) no longer structurally accepts the
`NodeJS.ReadableStream` interface `S3StorageService.putStream()` was typed to take; only a
concrete `stream.Readable` satisfies it now.
**Severity:** High — `npm run build` failed for the whole repo, blocking every agent.
**Fix:** `src/core/storage/s3-storage.service.ts` — cast the `Body:` argument in the
`Upload({...})` params to `stream.Readable` at the one call site (`putStream`). No behaviour
change (any readable stream works identically at runtime; only the type-checker's view of the
parameter differs). Did not touch `StoragePort`'s public `putStream?()` signature — that is
another phase's interface and the fix does not need to widen or narrow it.
**Verified:** `npm run build` and `npm run lint` both clean afterward.

## B-026 — `scripts/backup.sh` would fail on its first real run: `pg_dump` rejects Prisma's `?connection_limit=N` query param, and running inside the postgres container can't reach the host-published port · FIXED
**Found:** Phase 12, writing `scripts/restore-drill.sh` and actually executing it (not just
reading `backup.sh`) against real prod. `PROD_DATABASE_URL`/`.env.production`'s `DATABASE_URL`
is `postgresql://eld_prod:...@127.0.0.1:55432/onebook_eld?connection_limit=20` (Prisma-style —
`connection_limit` is a Prisma connection-pool parameter, not a real libpq URI parameter).
Passing that DSN straight to `pg_dump`/`psql` fails immediately: `invalid URI query parameter:
"connection_limit"`. Separately, `backup.sh` runs `pg_dump` via `docker exec onebook-postgres`
— i.e. *inside* the postgres container — but kept the host-side DSN's port (`55432`, the
compose-published host mapping); the container's own postgres listens on `5432`, and `55432` is
not reachable from inside the container's own network namespace (`Connection refused`). Either
bug alone means `backup.sh` had never actually produced a dump; both were silent until an actual
execution — `backup.sh`'s existing description/comments read as complete and had no other
script exercising it. A third, more fundamental bug in the same guard: `DB_NAME=$(node -e "..."
PROD_URL="$PROD_URL")` passed `PROD_URL=...` as a trailing shell *argument* to `node`, not a
prefix env-var assignment — `process.env.PROD_URL` was therefore always `undefined` inside the
script (Node's own argv, not env), so `DB_NAME` was always empty and the script always exited
with "refusing to run — PROD_DATABASE_URL does not point at onebook_eld" no matter what DSN was
given. This is the bug that surfaced first when actually running it.
**Severity:** Critical (tz.md §22.4: "a backup that has never been restored is not a backup" —
worse here, a backup that has never even been *taken* is not a backup; this would have been
discovered for the first time during a real incident).
**Fix:** `scripts/backup.sh` — env-var-for-command now uses the correct prefix form
(`PROD_URL="$PROD_URL" node -e "..."`, not a trailing argument) for both the `DB_NAME` guard
and the new container-local, query-string-free DSN builder (`host=127.0.0.1`, `port=5432`, same
user/pass/db) used for `pg_dump` inside the container. `scripts/restore-drill.sh` (new, same
task) uses the same prefix form throughout and additionally builds a query-string-free
*host-side* DSN for the `psql` row-count check that runs on the host, not in the container.
**Verified:** `bash scripts/backup.sh` against real prod produced an actual 211 KB dump file at
`BACKUP_DEST` (previously: always refused to run). `bash scripts/restore-drill.sh` against the
real prod DB (`onebook_eld`, empty — 0 rows in every checked table) end to end: fresh
`pg_dump`, scratch DB `onebook_eld_restore_drill_<pid>_<rand>` created, `pg_restore`d into, row
counts compared (0=0 across `User`/`Driver`/`Vehicle`/`EldEvent`/`DailyLog`/`AuditLog`),
`eld_prod`'s `UPDATE`/`DELETE` privileges on `EldEvent` and `AuditLog` confirmed `false`
post-restore (append-only preserved), scratch DB dropped on exit. Full output in the Phase 12
session report.

## B-027 — any authenticated principal could accept a carrier's §395.30 log edit on the driver's behalf · FIXED
**Found:** Phase 12 security review, grepping every route's authorization decorator against the
route it guards (`src/common/guards/route-surface.ts`). `POST /logs/edit-requests/:id/accept` and
`.../reject` carried **no** `@Perm` and no `DriverGuard`; the only scoping was
`if (actor.type === 'driver' && actor.id !== request.driverId)` inside
`LogsService.loadPendingRequest`, which does nothing at all for a non-driver actor. A
permission-less back-office user, or an API key with an empty `scopes` array, could therefore
activate a carrier-proposed edit: the proposal (`recordStatus = 3`) became the active record and
the original was marked Inactive — Changed, with no driver involvement. The same person who
proposes an edit could accept it.
**Severity:** Critical — defeats 49 CFR §395.30(c)(1) and the tz.md §23 checklist line "edits are
proposals only; never take effect without driver certification". This is HOS falsification, not a
permission nit.
**Fix:** `@UseGuards(DriverGuard)` on both routes (`logs.controller.ts`) plus defence in depth in
`LogsService.loadPendingRequest` — a non-driver actor now gets `403 DRIVER_CONTEXT_REQUIRED`
before anything is read. Regression tests: `logs.service.spec.ts` ("never lets a back-office user
or API key activate a proposal") and `route-surface.spec.ts` ("keeps the §395.30 accept/reject
pair on a driver token only").

## B-028 — a driver could claim any other driver's unidentified-driving segment · FIXED
**Found:** Same pass. `UnidentifiedService.confirm` with `accept: true` assigned the segment to
`actor.id` with no check that the driver had anything to do with the segment's vehicle. Claiming is
not self-harm: the segment leaves the unidentified pool, so driver A absorbing driver B's driving
hides it from B's record (and from the carrier's "was this you?" queue).
**Severity:** High — §395.32 attribution integrity; an HOS-hiding path reachable with nothing but a
valid driver token and a segment id.
**Fix:** `UnidentifiedRepository.hasDriverVehicleAssociation(driverId, vehicleId, at)` (assignment,
or the last LOGIN/LOGOUT event on that unit before the segment end being a LOGIN) is now required
for a self-claim; a refusal writes `UNIDENTIFIED_CONFIRM_DENIED` to the audit log and answers 403.
The carrier's own `POST /unidentified/:id/assign` (`hosEdit: FULL`, audited) is unchanged.
Regression tests in `unidentified.service.spec.ts`.

## B-029 — the offline-sync idempotency ledger was keyed by a client-chosen id with no driver scope · FIXED
**Found:** Same pass, reading `mobile-sync.service.ts` against `SyncedChange` in the schema.
`clientId` is `@unique` table-wide, its value is chosen by the mobile client (any string, 8–64
chars), and `findSyncedByClientId(clientId)` did not filter by driver. A driver could therefore
submit a change under an arbitrary `clientId`; when another driver's device later synced a genuine
queued change with that id, `processOne` saw "already processed", returned the attacker's outcome
and **never applied the mutation** — a silently dropped HOS change — while also exposing the other
driver's status/errorCode.
**Severity:** High — silent loss of a §395 duty-status/log mutation plus a cross-driver information
leak. Exploitability depends on predicting the victim's `clientId`, which is app-implementation
dependent (deterministic ids would make it trivial).
**Fix:** the stored key is namespaced (`syncLedgerKey(driverId, clientId)` = `"<driverId>:<clientId>"`)
and the lookup takes the driver id; the bare form is still matched **for the same driver** so rows
written before this change stay idempotent. No migration needed — the column is free-form text and
its value never leaves the server (the sync response echoes the request's `clientId`). Tests:
`mobile.repository.spec.ts`, plus a scoping assertion in `mobile-sync.service.spec.ts`.

## B-030 — WebSocket: token accepted from the query string, `origin: true` CORS, and rooms authorized by name pattern only · FIXED
**Found:** Same pass, `src/modules/realtime/realtime.gateway.ts`. Three issues in one file:
(1) the handshake token was read from `handshake.query.token` as a fallback, which tz.md §12.2
forbids in so many words ("Token query string'da yuborilmaydi") because proxies, CDNs and access
logs persist it; (2) `cors: { origin: true, credentials: true }` reflects any Origin back — a
wildcard in all but name; (3) `subscribe` only checked the room *name pattern* and the
`driver:`/`user:` self-match, so any authenticated socket could join `conversation:{id}` and
receive every message pushed into a thread it is not a participant of, or `vehicle:{id}` for any
unit in the fleet. An unauthenticated socket could also still reach `subscribe` for `fleet`.
**Severity:** High (message/telemetry disclosure across drivers + token-in-log exposure).
**Fix:** token read from `handshake.auth.token` only; CORS reads the same `CORS_ORIGINS` allowlist
as REST and fails closed when unset; new `RealtimeRoomAuthorizer` requires conversation
participation, restricts `vehicle:*` to a driver's own assigned unit, keeps `fleet`/`violations`
out of driver tokens, denies unknown rooms and refuses any socket with no bound principal. Tests:
`src/modules/realtime/room-authorizer.spec.ts`.

## B-031 — `POST /reports/generate` queued unvalidated `params`, so an unbounded report window reached the worker · FIXED
**Found:** Same pass. `GenerateReportDto.params` is `z.record(z.unknown())`; only the synchronous
preview routes parsed the per-type schemas, and those schemas had no range cap either. A single
cheap request (`from=1900-01-01&to=2999-12-31`) pinned a report worker for as long as it took.
**Severity:** Medium (authenticated DoS; needs `reports: FULL`).
**Fix:** `ActivityReportParamsDto` / `DvirReportParamsDto` / `FmcsaPackParamsDto` now enforce a
range (366 days; 62 for the FMCSA pack, matching `GET /logs/:driverId/range`), and
`ReportsService.generate` parses `params` with the schema of the requested type before enqueuing.
Tests: `src/modules/reports/dto/reports.dto.spec.ts` and a new case in `reports.service.spec.ts`.

## B-032 — `PATCH /devices/:id/ble-status` mutated device state without an audit row · FIXED
**Found:** Same pass (`route-surface.spec.ts`'s audit-coverage assertion). Every other mutating
device route carries `@Audit`; this one did not, and `DevicesService` writes no audit row itself.
**Severity:** Low (§18 audit completeness).
**Fix:** `@Audit({ object: 'Device', action: 'UPDATE_BLE_STATUS' })`.

## B-033 — TZ §6.5's 300/min/driver ingest rate limit is not implemented · FIXED
**Found:** Phase 12 security review. `ThrottlerModule` is configured with a single 600/min bucket
keyed by **IP** (Nest's default tracker); the login family narrows to 5/min/IP. There is no
per-driver-token bucket anywhere, so a stolen driver token spread over many source IPs is limited
only by the global bucket, and one abusive device on a shared NAT consumes the whole carrier's
budget.
**Severity:** Medium — availability, not integrity (ingest itself is fully validated, capped at
500 events / 1 MB and idempotent by `uuid`).
**Fix:** new `src/common/throttler/` — a second named bucket `ingest` at **300 req / 60 s keyed by
driver** (`resolveDriverTracker`), active only on `/ingest/*` (`skipIf`) and sharing ONE key across
all four §7.1 endpoints (`generateKey` drops Nest's per-handler prefix). Counters moved to Redis
(`RedisThrottlerStorage`, atomic INCR+PTTL Lua, fails OPEN on a Redis outage so §395 ingest is
never dropped) because the API runs as several containers and the in-memory store would multiply
every §6.5 limit by the replica count. `PrincipalThrottlerGuard` replaces `ThrottlerGuard` as the
`APP_GUARD` purely to render the §20 envelope (`RATE_LIMITED` + `scope`/`limit`/`retryAfterSec`).
The 600/min `default` bucket and B-037's per-route `400 req/s` ingest ceiling are unchanged, and
the per-driver budget does not cap the fleet: 300/min = 5 req/s per driver, so §19's 300 req/s peak
needs only 60 concurrent drivers. Design in D-047; 12 unit tests in
`src/common/throttler/principal-throttler.spec.ts`, including "noisy driver blocked, second driver
on the SAME IP unaffected" and the fleet-throughput assertion.

## B-034 — `ReportSchedule.params` is still an unvalidated open record · OPEN (reports owner)
**Found:** Phase 12 security review, while fixing B-031. `report-scheduler.processor.ts` copies
`schedule.params` verbatim into a queued report, and `createSchedule`/`updateSchedule` never parse
it, so an unbounded window can be installed once and then re-run on a cron forever.
**Severity:** Low-Medium (needs `reports: FULL`; recurring instead of one-shot).
**Next step:** call the same per-type parse in `createSchedule`/`updateSchedule`. Not done here
because `modules/reports` is being edited concurrently by the retention-jobs task and because
existing schedules may carry shapes that would need a migration pass.

## B-035 — 25 transitive `npm audit` advisories (8 moderate / 17 high), none in an exposed path · OPEN, tracked
**Found:** Phase 12 supply-chain pass. `multer@2.2.0` (4 high, DoS/limit-bypass) via
`@nestjs/platform-express` — unreachable: no route parses multipart, uploads are presigned PUTs to
S3. `extract-zip@2.0.1` (2 high, symlink path traversal) via `puppeteer` — browser-download time
only. `deepmerge-ts@7.1.5` (high, stack exhaustion) via `prisma/config` — build-time.
`uuid@9.0.1` / `teeny-request` / `retry-request` / `google-gax` / `@google-cloud/*` (moderate) via
`firebase-admin@13.10.0` — clearing them needs `firebase-admin@14`, a semver-major bump that
touches the auth path and should not ride along with a hardening pass.
**Severity:** Medium as a portfolio, Low individually given reachability.
**Next step:** schedule the `firebase-admin@14` upgrade with an auth-path regression run; re-check
`multer` once `@nestjs/platform-express` ships `>= 2.3.0`. Also worth setting
`SCARF_ANALYTICS=false` in CI/Docker — `@scarf/scarf` is install-time analytics with a postinstall
script. **Not a finding:** the vendored `dotenv` that prints `www.vestauth.com` /
`www.dotenvx.com` lines during test runs is the genuine published package — see
`docs/threat-model.md` §10 for the version/integrity comparison.

## B-036 — `report.processor.ts` computed `Report.expiresAt` with local-timezone `Date.getMonth()`/`setMonth()` instead of UTC · FIXED
**Found:** while auditing Phases 6-10 for the compliance-checklist line "All timestamps stored
in UTC, converted to carrier region only for display" (tasks.md). `expiresAt.setMonth(expiresAt
.getMonth() + REPORT_RETENTION_MONTHS)` reads/writes the Node process's LOCAL calendar, not UTC
— harmless only as long as every deployment happens to run with `TZ=UTC`. Under any other `TZ`
this can shift a report's 24-month S3 retention expiry by up to a day around a month boundary.
**Severity:** Low (no observed prod impact — this repo's containers run `TZ=UTC` — but it is
exactly the class of bug the compliance line exists to prevent, and it is silent: nothing
fails, a file just expires a day early/late).
**Fix:** replaced with `DateTime.utc().plus({ months: REPORT_RETENTION_MONTHS }).toJSDate()`
(luxon), same pattern already used by `ifta-nightly.processor.ts`/`retention.processor.ts` for
UTC-safe calendar month arithmetic.
**Scope note:** a repo-wide grep (`getHours|getDate|getMonth|getFullYear|getMinutes|DateTime
.local|moment()`) found this as the only local-time-construction hit in `src/`; Phases 6-10's
own modules (mobile, service, dtc, trips, safety, geofences, messaging, notifications, reports)
use `dayStart`/`dayEnd` (`hos/engine/timezone.ts`) and `cron-parser`'s `tz` option correctly —
UTC storage, timezone applied only at read/format time. Not audited here: whether every
`DateTime` column across the whole schema (all `TIMESTAMP(3)` without `@db.Timestamptz`,
Phase 1/3's init migration) plus a non-UTC Postgres server `TimeZone` setting could interact
badly — that is a Phase 1/3 schema-level design question, out of this task's Phase 6-10 scope,
flagged here for `eld-prisma-db`/`eld-architect` to confirm the Postgres container's
`TimeZone` is pinned to UTC (the compose/env files this task touched don't set it explicitly).

## B-037 — global 600 req/min default throttle blocked the §19 ingest targets outright · FIXED
**Found:** Phase 12 k6 load suite (`test/load/k6-acceptance.js`) against `POST /ingest/events`.
`app.module.ts` registers one global `ThrottlerGuard` at `600/60_000ms` (10 req/s) and
`IngestController` carried no per-route override, so the controller that TZ §19 requires to
sustain **50/s and burst to 300/s** was capped at a third of even the sustained target before a
single driver hit their own limit. First k6 run: 2156/2704 `ingest/events` calls (80%) rejected,
2104 of them `ThrottlerException: Too Many Requests` (the rest were DB pool timeouts, see B-038).
A whole fleet legitimately shares one depot NAT egress IP, so the failure mode is "one truck's
BLE catch-up burst 429s the rest of the fleet," not just a load-test artifact.
**Severity:** High — this made the documented ingest throughput target structurally
unreachable, not just slow.
**Fix:** `@Throttle({ default: { limit: 400, ttl: 1000 } })` on `IngestController`
(`src/modules/ingest/ingest.controller.ts`), i.e. its own ceiling above the 300/s peak target
instead of inheriting the app-wide 10/s default. Re-run after the fix: `ingest/events` 200/202
rate rose from 20% to 80% failing-check → passing-check split largely reversed (488/606 = 80.5%
pass on the second run, remaining failures are B-038's DB pool exhaustion, not throttling —
`ThrottlerException` count fell from 2104 to ~0 in the app log for that run).
**Not fixed as part of this same pass:** whether `/mobile/sync` and `/mobile/hos-state` (also
driver-token, also periodic background traffic) need the same treatment — this run didn't push
them hard enough to tell; flagged for whoever owns those controllers next.

## B-038 — Prisma `connection_limit=10` in `.env.development` vs. the §19-mandated 20, and it is not enough for the ingest peak target either way · FIXED
**Found:** same k6 run as B-037. Once the throttler stopped being the bottleneck, the app log
showed 324 occurrences of `Timed out fetching a new connection from the connection pool
(...connection limit: 10)` / Prisma `P2024`, all from `ingest.repository.js` (`device
.findUnique`, `eldEvent.findMany` inside the detector window queries) and from `psql` itself
returning `FATAL: too many connections for role "eld_dev"` at the Postgres level during the
same window.
**Two distinct problems bundled here:**
1. `backend/.env.development` sets `DATABASE_URL=...connection_limit=10`, but tz.md §19's own
   rule list says `Prisma connection_limit=20`. The dev env is already under its own documented
   floor.
2. Even the documented 20 would not obviously survive a genuine 300/s peak with multiple Nest
   instances or concurrent test suites sharing the same Postgres container (dev box also had
   `eld-devops`/`eld-security`/`eld-reports-jobs` test runs going at the same time — see the
   contention note below).
**Severity:** Medium in isolation (a one-line env fix), but it directly caps the load-tested
throughput and masks whether the ingest code path itself would meet the target with proper
headroom.
**Fix:** literally setting dev to `connection_limit=20` (the tz.md §19 number) does not work —
`eld_dev` carries a hard `ALTER ROLE eld_dev CONNECTION LIMIT 10` (tz.md §22.3.4, also this
agent's own Hard Rules) that Postgres enforces independently of Prisma's own pool-size param, so
a 20-wide app pool against a 10-wide role just hits `P2024` at 10 instead of 20. The real defect
was that `connection_limit=10` equaled the role cap one-for-one, leaving **zero** spare for the
second consumer that was always going to show up: `test/setup/integration.setup.ts` (and
`e2e.setup.ts`) load the same `.env.development`, so `test:integration`/`test:e2e` open a
second pool against `eld_dev` while the always-on `api-dev` container already holds its own
open. Set `connection_limit=4` in `.env.development`, `.env.development.example`, and
`.env.example` (`.env.production`/`.env.production.example` were already correct — `api(20) +
worker(20) = eld_prod`'s `CONNECTION LIMIT 40` exactly, worker being one process/one pool
shared by all `src/workers/*.processor.ts`, not one per processor). `4` leaves `api-dev(4) +
one concurrent test run(4) = 8` of `10`, with 2 spare for ad hoc `psql`/`migrate` — full
arithmetic and pool-budget table in `docs/deploy.md` "DB connection pool budget", decision
recorded as D-049. Also added `EldDevConnectionsNearLimit`/`PostgresConnectionsNearLimit` to
`docker/prometheus/alerts.yml` (fires at 80% of the role cap, before `P2024`s start) plus a
`postgres_exporter` scrape target in `docker/prometheus/prometheus.yml` (not yet deployed on
this box, same as `node_exporter` for `DiskUsageHigh` — hand it to whatever Prometheus already
runs here) so this class of saturation shows up before a load test rediscovers it.
**Verified:** recreated `api-dev` (`docker compose up -d --force-recreate api-dev` — the
image build for this container is currently broken by unrelated concurrent-agent edits mid
`npm run build`, see the note below; `npm run build` succeeds on the host directly). Verified
the pool fix itself without the container: two independent 4-connection `PrismaClient` pools
against `onebook_eld_dev` (simulating `api-dev` + a concurrent test run, 8 of the role's 10)
fanned 20 concurrent `SELECT` queries with zero `P2024`/connection errors.
**Not fixed / handed off:** (a) the `api-dev` Docker image currently fails `npm run build`
inside `docker build` (exit 1) even though the same command succeeds on the host — this is
unrelated to the pool change (env files aren't copied into the image; they're `env_file`-mounted
at runtime) and looks like a mid-edit snapshot from a concurrent agent's in-flight `src/`
change; whoever owns that file should re-run `docker compose up -d --force-recreate api-dev`
once the tree is stable and confirm the container comes up healthy. (b) point 2 above (whether
the ingest 300/s peak target is reachable on dev at all under this 10-connection role fence) is
not resolved and, per the arithmetic in D-049, structurally cannot be with more than one
concurrent `eld_dev` consumer — flagged as an operational limitation in `docs/deploy.md`
rather than silently worked around by widening the fence, which is outside this fix's authority
to change.

## B-039 — `hos/` coverage gate is actually red: 3 engine files sit below the 95% branch floor, not just the aggregate · FIXED
**Found:** Phase 12 CI-gate verification (`npx jest --coverage`, twice, independently — once
mid-contention, once clean). `jest.config.js`'s `coverageThreshold` keys the `hos/` requirement
by glob (`'src/modules/hos/**/*.ts'`), which Jest evaluates **per matching file**, not as one
aggregate number. The aggregate looks fine (`hos/engine` 99.52% stmts / 97.35% branch / 100%
funcs / 100% lines — passes 95% on every axis when averaged), which is presumably why
`tasks.md`'s "`hos/` (TS) coverage ≥ 95%" line is already checked. But the actual gate fails on
three individual files, identically on both runs:
- `hos/engine/cycle.ts` — branches 93.93% (< 95%)
- `hos/engine/timezone.ts` — branches 83.33% (< 95%)
- `hos/engine/normalize.ts` — branches 93.75% (< 95%)

`npm run test:cov` therefore exits non-zero on `hos/` branch coverage alone, independent of any
of the unrelated integration/e2e failures the same run also had (those were DB-connection
exhaustion from concurrent agents, B-038 — this finding is not).
**Severity:** Medium — doesn't affect runtime behavior, but the CI gate as configured is not
actually green, and `tasks.md`'s Global-gates / CI-coverage-gates checkboxes for `hos/` say it
is. Corrected both to unchecked below.
**Fix:** the four uncovered branches were identified exactly (from `coverage-final.json`, not
the line summary) and covered with real tests; the gate was NOT lowered and no
`istanbul ignore` was added. What each branch turned out to be:
- `cycle.ts:27` (`candidate > now` → skip) — reachable with millisecond ELD timestamps: a rest
  run of 33:59:59.600 rounds to `durationSec === 34 h` while the 34th hour has not actually
  arrived. Behaviour is correct (never the more generous reading). Covered by
  `resolveRestartEnd — sub-second precision at the 34 h mark`.
- `cycle.ts:48` (`sliceEnd <= sliceStart` → skip) — reachable when a calendar date has zero
  local length, i.e. a zone that skipped a whole day (Pacific/Apia 2011-12-30). Behaviour is
  correct: the nonexistent date gets no seconds and its neighbours keep all of theirs.
- `normalize.ts:62` (`eventSequenceId ?? 0`, both operands) — reachable whenever two records
  share an instant and at least one has no sequence id (unidentified-driver assignments and
  engine-synthesised records arrive without one). Covered by four ordering tests.
- `timezone.ts:49` (`part ? Number(part.value) : 0`) — **genuinely unreachable through
  `wallClock()`**: `formatter()` requests all six numeric fields and every ICU build emits them,
  so no timezone/instant can produce a missing part. Rather than delete the defensive default
  (a `NaN` day key would silently drop a whole RODS day from the cycle) or ignore it, the
  parts→`WallClock` mapping was extracted to the exported, pure `wallClockFromParts()` and
  tested directly with incomplete parts lists. Stated plainly: that branch is unreachable via
  `Intl`, and it is now covered at the contract level instead of being papered over.
Covering `cycle.ts:48` also exposed B-041 below. Result: `cycle.ts`, `timezone.ts`,
`normalize.ts` and every other `hos/` file are now 100% statements/branches/functions/lines
(`npx jest --coverage --selectProjects unit`), and `tasks.md`'s gate line is re-checked.

## B-041 — `zonedToUtc()` resolved a nonexistent local time BACKWARD, so in zones that change clocks at midnight `dayStart` disagreed with `dayKey` and an hour of on-duty time vanished from the cycle · FIXED
**Found:** while making `cycle.ts:48` (`onDutyByDay`'s zero-length-slice guard) reachable for
B-039. Both engines' two-pass offset search returned the *pre-transition* instant for a local
time inside the spring-forward gap, contradicting their own doc comment ("Local times that do
not exist (the spring-forward gap) resolve forward"). In `America/Havana` (DST starts at 00:00
local) `dayStart('2026-03-08')` came back as `2026-03-08T04:00Z`, whose local wall clock is
`2026-03-07 23:00` — so `dayEnd('2026-03-07')` preceded the real end of 03-07 by an hour.
`dayKey()` still mapped that hour to `2026-03-07`, so in `onDutyByDay` the slice
`[max(from, dayStart), min(end, dayEnd)]` was empty and the hour was **dropped from the 70/8
cycle entirely** (driving time reduced by a path — forbidden). `dayLengthSec` also reported
03-07 as 23 h and 03-08 as 24 h, i.e. both back to front.
**Severity:** Medium. No US/territory home terminal is affected in practice — every US zone
transitions at 02:00, so local midnight always exists, and the fix is a verified no-op for
`America/{New_York,Chicago,Denver,Los_Angeles,Anchorage,Phoenix}` and `Pacific/Honolulu` across
both 2026 transitions. It is a real data-loss bug for any non-US midnight-transition terminal
(Havana, Santiago) and it broke the function's documented contract, which the Dart mirror
copies verbatim.
**Fix:** after the two passes, the corrected instant is rendered back to a wall clock; if it
does not match the requested one the local time is in the gap and the LATER candidate is
returned (forward resolution). Ambiguous fall-back times still resolve to their first
occurrence. Applied identically in `src/modules/hos/engine/timezone.ts` and
`mobile/lib/hos/engine/timezone_rules.dart` so the ports stay behaviourally identical.
One pre-existing test (`timezone.spec.ts`, "still returns a real, deterministic instant for a
local time inside the DST gap") had pinned the wrong behaviour as if specified — it asserted
`2025-03-09T06:30:00.000Z` for a 02:30 that never happens, i.e. 01:30 EST, an hour *before* the
requested time. It now asserts the forward resolution (`07:30Z` = 03:30 EDT) and cites this
bug. No conformance fixture covered the gap, so all 54 golden fixtures still pass on both
sides; `HOS_ENGINE_VERSION` stays `1.0.0` (see D-048).

## B-040 — `RetentionRepository.parseBound()` read `EldEvent` partition bounds with the JS legacy (local-timezone) Date parser instead of UTC · FIXED
**Found:** `test/integration/retention.spec.ts`, while building the retention.processor
(tasks.md compliance line "RODS retained 6 months, audit retained 24 months") — a scratch
partition created for `2003-03-01` came back from `RetentionRepository.listEldEventPartitions()`
as `2003-02-28T23:00:00.000Z`. `pg_get_expr(relpartbound, oid)` on `EldEvent` (a `TIMESTAMP(3)`
column, no time zone — tz.md §5.5 deviation #1) renders bounds as `'2003-03-01 00:00:00'`
(space, not `T`, no zone suffix). `new Date('2003-03-01 00:00:00')` is NOT ISO-8601 shaped
(needs `T` or date-only) so V8 falls back to its legacy parser, which reads that exact shape
in the **process's local time zone**, not UTC — this Jest run happened to execute under a
non-UTC `TZ`, which is exactly the class of bug the "All timestamps stored in UTC, converted to
carrier region only for display" compliance line exists to catch, and exactly why that line's
audit (this task) is worth doing even on brand-new code.
**Severity:** would have been High if shipped un-caught: `retention.processor` is a compliance
job — an hour of skew right at a month boundary could make it drop a partition that still had
an in-window RODS row, or (more likely, since it only makes partitions look OLDER) keep one an
hour past due. Caught before ever running against real data; only ever touched a same-session
scratch partition.
**Fix:** `parseUtcTimestamp()` explicitly splices `T`/`Z` onto the captured bound text before
constructing the `Date`, forcing UTC interpretation regardless of the running process's `TZ`.
Covered by `test/integration/retention.spec.ts`'s first assertion (`rangeStart`/`rangeEnd`
exact-ISO-string checks), which reproduced this failure before the fix.

## B-042 — no `.dockerignore`, so `COPY . .` overwrote the image's Alpine/musl `node_modules` with the host's glibc build · FIXED
**Found:** picking up the `api-dev` rebuild handoff left by the Phase 12 devops task, which
reported that `npm run build` failed *inside* `docker build` while the identical command
succeeded on the host. That symptom was blamed on a concurrent agent's mid-edit `src/`
snapshot; it was not — the tree was stable and the build still failed.
**Cause:** the repository had no `.dockerignore`. The build context was therefore 754 MB
(618 MB of it `node_modules`, plus `dist/`, `coverage/`, `.git/`), and more importantly
`Dockerfile`'s `COPY . .` in the `build` stage ran *after*
`COPY --from=deps /app/node_modules ./node_modules` — so the host's `node_modules` replaced
the ones `npm ci` had just installed for `node:24-alpine`. The host installs against glibc,
the image runs musl; Prisma's query-engine binaries are the most sensitive to that mismatch.
**Severity:** Medium-High. This is not a dev-only convenience issue — `api`, `worker` and
`api-dev` are all built from this same `Dockerfile`, so every production image inherited
whatever native binaries happened to be on the build host, and the build was only ever
"working" when the host and the image agreed by luck.
**Fix:** added `/root/projects/devline/eld_logistics/backend/.dockerignore` excluding
`node_modules`, `.git`, `dist`, `coverage`, `*.tsbuildinfo`, `.env`/`.env.*`, and the
build-irrelevant `test`, `docs`, `scripts`, `*.md`, `.github`.
**Verified:** build context 754 MB → 5.7 MB; `docker compose build api-dev` now completes
(`RUN npm run build` 69.8 s, previously the failing step), image `onebook-eld-api-dev:latest`
built clean. The `api-dev` container itself is not running and is not needed for host-side
development — only the image build was verified.
**Note:** the `.env`/`.env.*` exclusion is defence in depth. The Dockerfile never copied env
files into a layer; compose mounts them at runtime via `env_file`. They simply have no
business being in the build context.
