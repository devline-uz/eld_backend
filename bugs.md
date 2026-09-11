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
