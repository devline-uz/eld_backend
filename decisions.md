# Decision log

Choices made autonomously while executing `tasks.md`, when the roadmap or `tz.md` left a
question open and waiting for an answer would have stalled the work. Format: the problem, the
options considered, the choice, and why.

Conflict order that governs every entry:
**FMCSA 49 CFR §395 > Pacific Track docs > `tz.md` > Figma > existing code.**

---

## D-016 — `seed-shape.spec.ts` filters known non-seed prefixes instead of asserting raw counts
**Date:** 2026-09-11 · **Phase:** coverage/QA pass (`eld-qa-test`)

**Problem.** B-012: `onebook_eld_dev` carries rows no seed produced (`TEST-*`/`DBG2-*` vehicles,
`test_driver_*` drivers, `PT30_TEST_*` device) left by ad-hoc debugging, plus rows two e2e specs
used to leak on a failed run before this pass added `finally` cleanup. `seed-shape.spec.ts`
asserts exact row counts (69 vehicles, 58 drivers, 4 roles) straight from `prisma.<model>.count()`,
so any of this pollution fails it — and hard-`DELETE` of the polluting `Vehicle`/`Driver`/`Device`
rows is blocked fleet-wide by B-009 whenever they still have `EldEvent` history.

**Options.** (a) Loosen the assertions to `toBeGreaterThanOrEqual(69)` etc. (b) Filter the counts
to exclude rows matching the known non-seed prefixes, keeping an exact match against the true
seed. (c) Leave it red until a human runs `db:reset:dev && db:seed`.

**Choice.** (b), plus (c) as the follow-up still needed for the specific stray `Vehicle`/`Device`
rows this pass could not safely bulk-delete (see B-012).

**Why.** (a) is a real loosened assertion in the sense the brief warns against: it would keep
passing if the seed script silently produced 68 vehicles instead of 69, which is exactly the
regression this spec exists to catch. (b) keeps the assertion exactly as strict for its actual
subject — the seeded Figma demo dataset — while not conflating "seeded" with "whatever is in the
table right now regardless of source". (c) alone was rejected as the only fix because it leaves a
correct, gate-blocking spec red indefinitely over pollution the spec itself doesn't need to be
red about; it remains necessary for the handful of rows this pass genuinely could not remove
(bulk deletes against the shared dev DB were correctly refused while another agent was mid-run).

---

## D-001 — Production migrations are batched, not applied per phase
**Date:** 2026-09-10 · **Phase:** 1+

**Problem.** `prisma migrate deploy` against `onebook_eld` is blocked in this session by the
permission sandbox; only the user can run it. Later phases will each add migrations.

**Options.** (a) Stop at every phase and wait for the user to run the prod deploy. (b) Apply
migrations to dev only, keep prod rollout as one batched command the user runs later. (c) Skip
prod entirely until Phase 12.

**Chosen: (b).** The user is asleep and asked not to be interrupted. Every migration is created
and verified on the dev DB, exactly as tz §22.3.3 prescribes; `migrate deploy` is replayable and
order-preserving, so a batched prod rollout produces an identical schema. `db:check-drift` will
report drift until that command is run — expected, not a regression.

**How to settle it.** Run from `backend/`:
```
set -a && . ./.env.production && set +a && npx prisma migrate deploy
DEV_DATABASE_URL=$(grep '^DATABASE_URL' .env.development | cut -d= -f2-) \
PROD_DATABASE_URL=$(grep '^DATABASE_URL' .env.production | cut -d= -f2-) npm run db:check-drift
```
Phases 1 migrations (`20260910180242_init`, `20260910190500_append_only_revoke_hardening`) are
already on prod. Anything later is pending.

---

## D-002 — `AuditLog.before`/`after` are a field-level diff, not full snapshots
**Date:** 2026-09-10 · **Phase:** 1

**Problem.** `tz.md` §18 defines `AuditLog.before Json?` / `after Json?` but the writer left
both null: `AuditService` only ever recorded actor/action/object/ip/userAgent. An auditor
reading the log could see *that* a role or user changed, never *what* changed. Fixing it means
deciding (a) where the snapshot is captured without every `@Audit()` call site hand-assembling
`before`/`after`, and (b) what shape to store.

**Options.**
1. **Full before/after snapshots.** Store the entire entity twice, unchanged fields included.
   Simple, trivially queryable, but noisy — a 22-key `Role.permissions` change stores the
   permissions matrix twice even when one key flipped, and every row duplicates fields
   (`createdAt`, unrelated columns) that never change.
2. **Field-level diff.** Compare the pre- and post-handler snapshot and keep only the keys that
   actually differ, on both sides. Smaller rows, and `before`/`after` read directly as "what
   moved," which is what an auditor asks first. CREATE (`before = null`) and DELETE
   (`after = null`) keep the single available side in full, since there is nothing to diff
   against.
3. **Structured patch objects** (e.g. JSON Patch / RFC 6902). Most compact, but adds a
   dependency and a format an auditor has to learn to read a log row; overkill for a 22-key
   permission matrix and a handful of user/role/API-key fields.

**Chosen: (2), field-level diff.** Implemented as `diffSnapshots()` in
`common/audit/redact.ts`, fed by two calls to a new `AuditSnapshotRegistry`
(`common/audit/audit-snapshot.registry.ts`): `AuditInterceptor` loads a "before" snapshot from
the registry *before* invoking the handler (using the route's id param), then an "after"
snapshot once the handler returns (forced to `null` for `action === 'DELETE'`, since the row is
gone). Each feature module (`RolesModule`, `UsersModule`, `ApiKeysModule`) registers its own
loader in `onModuleInit`, keeping the interceptor decoupled from feature repositories — no call
site inside `RolesController`/`UsersController`/`ApiKeysController` assembles a snapshot by
hand, they only need `@Audit({ object, action })`. Every snapshot is redacted
(`redactSecrets()`, `AUDIT_REDACTED_FIELDS` = `passwordHash`, `twoFactorSecret`,
`recoveryCodes`, `refreshHash`, `keyHash`) and JSON-safed (`toJsonSafe()`, Dates → ISO strings,
BigInt → string) before it ever reaches `AuditRepository.insert`, which remains insert-only —
`AuditLog` is append-only at the DB level (TZ §18, `REVOKE UPDATE, DELETE`) independently of
this.

**Why.** A diff is what TZ §18's stated purpose — "who changed what" — actually needs, and
it's cheap to produce once a before/after pair exists at all; storing full snapshots would have
been strictly more data for less immediately-readable signal. The registry pattern was chosen
over injecting `PrismaService` directly into `AuditInterceptor` because `tz.md` §3.5 restricts
raw `prisma.*` calls to repositories — the registry lets repositories keep owning that access
while the interceptor stays a thin, reusable subscriber. Later phases (log edit, certification,
unit deletion, odometer calibration, data transfer, report export, carrier settings) plug into
the same mechanism with zero changes to `AuditInterceptor`/`AuditService` — see the note atop
`modules/audit/audit.module.ts`.

## D-003 — Phase 2 fleet: list pagination, module dependency direction, soft-delete, device pairing guard

**List pagination.** The Phase 2 brief says lists use `?page&limit&sort&q` with cursor
pagination on large tables. `Vehicle`/`Driver`/`Device` are fleet-sized (hundreds, not the
millions of `EldEvent`/`AuditLog`), and the Figma fleet screens ("Vehicles", "Drivers",
"Settings > ELD devices") show numbered page controls, not "load more" — so these three list
endpoints use offset paging (`page`/`limit`/`sort`/`q`, `common/dto/list-query.dto.ts`) instead
of `BaseRepository.paginate`'s cursor form, which stays reserved for genuinely large tables.

**Module dependency direction.** `VehiclesModule -> DriversModule -> (nothing)`,
`DevicesModule -> VehiclesModule`. Driver assignment (`POST /vehicles/:id/assign-driver`) and
device pairing (`POST /devices/:id/pair`) both need to reach across module boundaries; rather
than use `forwardRef` for a bidirectional graph, each cross-module need was resolved by picking
one canonical owner (the vehicle owns assignment, since the out-of-service hard rule is a
*vehicle* invariant; the device owns pairing, since `Device.vehicleId` is the single source of
truth) and injecting the *other* module's repository one-directionally. No endpoint exists on
`DriversController` for assigning a vehicle — the frontend calls the vehicle-side endpoint from
either screen.

**Soft-delete, not hard `DELETE`, for Vehicle/Driver/Device.** Originally implemented as
`prisma.<model>.delete()`. Changed after discovering bugs.md B-009: the append-only hardening
migration's `REVOKE UPDATE ON "EldEvent"` breaks Postgres's own `ON DELETE SET NULL` FK action
for any row `EldEvent` references, fleet-wide (reproduced even as the Postgres superuser).
Independent of that bug, hard-deleting a vehicle/driver/device with historical `EldEvent`/HOS/DVIR
data is the wrong compliance behavior anyway — FMCSA data must trace back to a real unit/driver/
device, not an orphaned id. `remove()` on all three services now flips `status` to a terminal
value (`Vehicle.status = INACTIVE`, `Driver.status = TERMINATED`, `Device.status = RETIRED` +
unpaired) and disconnects any live assignment/pairing first. `TrailersService.remove()` keeps a
real hard delete — `Trailer` has no `EldEvent` FK pointed at it, so B-009 doesn't apply.

**Device pairing never trusts the DB unique index alone.** `@@unique([vehicleId])` on `Device`
is real (confirmed against `pg_indexes`), but Prisma's `connect` on an optional 1:1 relation
implements "steal" semantics: connecting a second device to an already-paired vehicle silently
disconnects the first device (`UPDATE "Device" SET "vehicleId" = NULL ...` before the insert)
instead of ever violating the unique index — proven by `test/integration/fleet-crud.spec.ts`.
`DevicesService.pair()` therefore does its own `findByVehicleId` check and throws
`DEVICE_ALREADY_PAIRED` *before* calling `connect`, rather than depending on Prisma/Postgres to
reject the second pairing. The DB index still matters as a last-resort backstop against anything
that writes `vehicleId` with raw SQL, just not against Prisma's own relation sugar.

---

## D-004 — API key scope change is its own `PATCH /api-keys/:id/scopes`, not folded into revoke/create
**Date:** 2026-09-11 · **Phase:** 11

**Problem.** `tasks.md`'s Phase 11 brief for `eld-auth-rbac` requires "key creation, scope change
and revocation" to each be `@Audit()`-ed, but the `api-keys` module inherited from Phase 1 only
had `create`/`revoke` — no scope-change endpoint existed at all, and TZ §11.7 only lists the
resource (`/api-keys`) without enumerating sub-routes.

**Options.**
1. Let scope edits happen through a generic `PATCH /api-keys/:id` that accepts any mutable field.
2. A dedicated `PATCH /api-keys/:id/scopes` endpoint, audited as its own action.
3. Force scope changes through revoke-and-recreate (no update path at all).

**Choice.** Option 2. **Why.** Option 1 would make the `@Audit()` action name ambiguous (`UPDATE`
covering both a rename and a privilege change is exactly the kind of audit-log vagueness §18 is
meant to prevent for a security-sensitive object). Option 3 forces a plaintext-key rotation on
every scope tweak, which is disproportionate and encourages copy-pasting the new key around.
`updateScopes` reuses the existing `keyHash`/`prefix` untouched, is gated by the same
`integrations:FULL` permission as create/revoke, and is tagged `@Audit({ object: 'ApiKey', action:
'UPDATE_SCOPES' })` so the audit log reads unambiguously. See also bugs.md B-010, found while
reading this module before extending it: `verify()` could never actually return the
`API_KEY_REVOKED` code because the repository query filtered revoked rows out before the check
ran.

---

## D-005 — `SupportTicket.number` generated from row count, with collision retry
**Date:** 2026-09-11 · **Phase:** 11

**Problem.** `SupportTicket.number` (unique, human-readable, e.g. `TCK-000001`) has no
generation rule in `tz.md` §5.10 or §11.7 — the schema just declares the column.

**Options.**
1. A dedicated Postgres sequence/identity column formatted at read time.
2. `COUNT(*) + 1` at write time, zero-padded, with a retry loop on the unique-constraint
   collision Prisma raises (`P2002`) if two creates race the same count.
3. A random suffix (UUID-derived) with no ordering meaning.

**Choice.** Option 2. **Why.** A real DB sequence (option 1) is the eventually-correct answer but
needs its own migration, which is out of scope for a module that only reuses existing models this
phase. A random suffix (option 3) defeats the point of a human-readable ticket reference support
staff read aloud on calls. Support-ticket creation is low-volume compared to `EldEvent`/telemetry
ingest, so the race window option 2 leaves open is narrow, and `SupportService.create()` retries
up to 5 times on `P2002` before giving up — good enough for this table's actual write rate. If
ticket volume ever grows enough to matter, swap in a Postgres sequence without changing the public
shape of `SupportTicket.number`.

---

## D-006 — `Integration.config` secret handling: field-level AES-256-GCM, not whole-blob encryption
**Date:** 2026-09-11 · **Phase:** 11 (`eld-reports-jobs`)

**Problem.** `tz.md` §16 says `Integration.config` is `Json // sirlar shifrlanadi` ("secrets are
encrypted") but the schema gives no shape per provider (McLeod, WEX/Comdata, QuickBooks, Slack,
generic `webhook`) and no key-management convention exists yet anywhere in the codebase (the
closest precedent, `FIREBASE_CREDENTIALS_FILE`, is a file path, not a symmetric key).

**Options.**
1. Encrypt the entire `config` JSON blob as one opaque string — simplest, but then even non-secret
   fields (a webhook URL, a sync-frequency flag) become unreadable without a decrypt round trip,
   which the admin UI needs for e.g. showing "connected to https://...".
2. Field-level encryption: walk `config`'s keys, encrypt values whose key name matches a
   credential-shaped pattern (`apiKey`, `clientSecret`, `accessToken`, `signingSecret`,
   `password`, ...), leave the rest (URLs, booleans, ids) as plain JSON.
3. Store secrets in a separate `Secret` table keyed by `(integrationId, name)`, `config` holds
   only non-secret fields.

**Choice.** Option 2. **Why.** Option 3 is the "more correct" long-term shape but needs its own
migration/model, out of scope for a phase that reuses the `Integration` table as given in
`tz.md`. Option 1 fails the "config secrets encrypted" requirement's spirit half-heartedly —
either everything is opaque (breaks the admin UI's need to show non-secret config) or nothing is.
Option 2 encrypts exactly the fields that are actually secrets (`isSecretConfigKey` regex in
`modules/integrations/lib/config-secrets.ts`), is idempotent (won't double-encrypt an
already-encrypted value on repeated upsert), and every read path (`list`/`get`/audit-log
before-after snapshot) goes through `redactConfigSecrets`, which never returns plaintext *or*
ciphertext for a secret field — only `[REDACTED]`.

**Key source.** AES-256-GCM key comes from env var `INTEGRATION_ENCRYPTION_KEY` (base64, must
decode to 32 bytes), read in exactly one place (`IntegrationCipherService`). The dev default in
`env.schema.ts` is a fixed, clearly-dev-only base64 string — same convention as `JWT_SECRET`'s
dev default. **Prod value must be set in the server secrets folder (this project's `.env`,
alongside `POSTGRES_SUPERUSER_PASSWORD`/`REDIS_PASSWORD`/etc.) and never committed.** A security
reviewer should check: (1) prod `.env` actually overrides `INTEGRATION_ENCRYPTION_KEY` away from
the dev default; (2) no code path logs a decrypted secret or a raw `config` object (only the
`redactConfigSecrets` view is ever logged/returned); (3) `getDecryptedSecret`/`decryptConfigSecret`
are called only from `IntegrationsService`-internal code and `WebhookProcessor`, never from a
controller; (4) the webhook processor decrypts the signing secret fresh from the DB on every
delivery attempt rather than persisting it — the only place that secret is ever plaintext outside
the DB decrypt call is the brief in-memory HMAC computation, never `WebhookDelivery` (which has no
secret column) and never the BullMQ job payload (`{ deliveryId }` only).

---

## D-007 — eRODS identifiers are normalised (trim + upper-case) rather than rejected on case
**Problem.** §395 Appendix A requires `eldIdentifier`/`eldRegistrationId` to be exactly 4
characters from `A-Z0-9`. An operator typing `obk1` or ` OBK1 ` in the Settings form is supplying
the right identifier in the wrong shape; strict rejection and silent acceptance are both bad
(the latter invalidates the output file).

**Options.** (1) Reject anything not already uppercase/trimmed — safest, most annoying, and a
lowercase value in the DB would have been the *only* symptom of the old bug (B-011). (2) Trim and
upper-case in the DTO, then validate the alphabet; store the normalised value. (3) Accept
anything 4 chars and normalise at file-generation time.

**Choice.** Option 2, with the DB CHECK enforcing the already-normalised form
(`^[A-Z0-9]{4}$` — the DB does *not* normalise, it only refuses). **Why.** Normalising once at
the edge means exactly one representation ever reaches storage, so every downstream consumer
(header segment, 4.8.2.2 file name, `DataTransfer`) can rely on the column without re-normalising
— Option 3 spreads that responsibility across every future eRODS code path and would let a bad
value sit in the DB until transfer time. Characters outside the alphabet (`#`, `,`, space,
non-ASCII) are still hard errors: those are typos, not formatting.

**Related.** `erodsMode=PRODUCTION` is refused while `eldRegistrationId` is NULL
(`422 TRANSFER_VALIDATION_FAILED`, reusing the existing code rather than adding one to the
append-only registry). This is the only *semantic* guard on the mode; the mode itself stays plain
data, so `tz.md` §10.1's "PRODUCTION o'tish — faqat sozlama / kod o'zgarmaydi" still holds: set
`eldIdentifier`, `eldRegistrationId`, `erodsMode=PRODUCTION` via `PATCH /carrier` and drop the
FMCSA credentials in the secrets folder. No code reads a hard-coded `'TEST'` anywhere.

---

## D-008 — The ingest checksum algorithm is defined by us: SHA-256/16 over a canonical raw-field string
**Date:** 2026-09-11 · **Phase:** 3

**Problem.** tz §7.2 shows `"checksum": "a3f9..."` on every ingested event and §7.3 rule 4 / §23
require it to be *verified*, but neither tz.md nor the Pacific Track docs name an algorithm or an
input set. Without one, "verified" is unimplementable and every event would look corrupt.

**Options.** (a) Store whatever the app sends and never verify — fails §23. (b) Require the SDK's
own frame CRC — not exposed through the unified SDK, and it covers the BLE frame, not our record.
(c) Define the algorithm on our side and have the Flutter app conform.

**Choice.** (c). `src/modules/ingest/checksum.ts` is normative: SHA-256, first 16 hex chars, over
a pipe-joined canonical string of `uuid|eventType|eventCode|eventDateTime(ISO, second precision)|
timezoneOffset|recordOrigin|recordStatus|lat(6dp)|lon(6dp)|rawOdometerKm|engineHours(2dp)`.
`canonicalString()` is exported so the mobile team can implement the identical string.

**Why.** Two properties are load-bearing. It hashes the **raw** values (raw coordinates, raw
metric odometer) and therefore runs *before* coarsening and unit conversion — that is what makes
it able to detect corruption on the BLE/HTTP path. And the value stored in `EldEvent.checksum` is
always the **server-computed** one, so any stored record can be re-verified years later even if
the app sent a corrupt value. A mismatch (or an absent checksum) is never a rejection: the event
is stored, diagnostic `3` is attached, and the batch answers `202 ACCEPTED_WITH_WARNINGS`
(§7.3 rule 4, and the §7.3 note "an ELD-recorded event must not be lost").

---

## D-009 — `eventSequenceId` is allocated from a counter table under an advisory lock, not from `MAX()`
**Date:** 2026-09-11 · **Phase:** 3

**Problem.** §5.5 requires a per-driver monotonic `1..65535` sequence that wraps to 1, assigned
once at ingest and never changed. The obvious implementation is `MAX("eventSequenceId") + 1` per
driver.

**Options.** (a) `MAX()` per driver. (b) A Postgres sequence per driver. (c) A counter table keyed
by driver, updated under `pg_advisory_xact_lock()` inside the batch transaction.

**Choice.** (c) — new `EventSequenceCounter` model (`key`, `lastSequenceId`). `key` is the
`driverId`, or `unidentified:<vehicleId>` for events with no driver (§7.4 rule 3), so unidentified
driving gets its own conforming series instead of colliding with a driver's.

**Why.** (a) is simply wrong once the counter wraps: after 65535 the maximum is no longer the
previous value, so ingest would restart at 65536 → out of range, or hand out duplicates. It is
also an ever-growing scan across every monthly partition of an append-only table. (b) creates
unbounded DDL (one sequence per driver) and sequences are not transactional, so a rolled-back
batch would burn numbers and leave gaps in a §395 series. (c) is O(1), wraps correctly, and is
serialized per driver by the advisory lock — proven by an integration test where four concurrent
transactions allocate 16 gap-free, non-overlapping numbers. On first use for a key the counter
seeds itself from the newest existing event, so pre-existing/imported data is never re-numbered.

---

## D-010 — Windowed §7.8 checks run after the batch commits, per-event checks run inside it
**Date:** 2026-09-11 · **Phase:** 3

**Problem.** §7.8 mixes two kinds of condition: per-event ones (timing `T`, missing-data `3`) and
24-hour windowed ones (`P`, `E`, `L`, `R`, `S`, diagnostics `1`, `2`, `4`, `5`). tz.md does not say
when they are evaluated, and §7.3 rule 6 requires the batch itself to be one transaction.

**Options.** (a) Everything inside the ingest transaction. (b) Everything in a BullMQ job.
(c) Split: per-event inside, windowed after commit.

**Choice.** (c). `T` and `3` are computed per event and written on the event row itself *and* as
their own eventType 7 records inside the same transaction. The windowed checks run right after
the commit, against the previous 24 hours, and log an eventType 7 record only for codes not
already logged in that window (so a malfunction is not re-recorded on every 60-second batch).

**Why.** (a) would make a five-event batch run five 24-hour aggregate scans while holding the
write transaction open — the exact p95 regression §19 warns about. (b) delays the malfunction
record behind queue latency, and §7.8's conditions must be visible on the driver's log
immediately. (c) keeps the transaction short, keeps the per-event flags atomic with the event
they describe, and is idempotent under retries thanks to the de-duplication query.

---

## D-011 — `EldEvent` has no foreign keys; integrity is enforced on the write path
**Date:** 2026-09-11 · **Phase:** 3 (fixes bugs.md B-009)

**Problem.** B-009: with the append-only `REVOKE UPDATE, DELETE` in place, *any* FK from
`EldEvent` to `Driver`/`Vehicle`/`Device` makes every hard delete of those parents fail with
`permission denied for table EldEvent` — including for rows that have no events at all, and
including for the superuser.

**Options.** (a) Keep `SET NULL` and live with soft-delete everywhere (the Phase 2 workaround).
(b) Switch to `ON DELETE NO ACTION`. (c) Replace the REVOKE with `BEFORE UPDATE/DELETE` triggers
and grant UPDATE back. (d) Drop the FKs and validate on the write path.

**Choice.** (d).

**Why.** (b) was implemented first and measured: it does not help, because `NO ACTION` still runs
`SELECT ... FOR KEY SHARE` on the referencing table and row locks need UPDATE or DELETE
privilege. (c) would weaken the §23 compliance invariant from a privilege — which no code path
can bypass — to a trigger, which `session_replication_role = replica` disables; that trade is not
acceptable for the table FMCSA audits. (a) hides a database defect behind a product rule.
(d) removes the conflict at its root: an append-only ledger cannot participate in referential
integrity at all. The ids stay indexed scalars, ingest resolves and verifies device → unit →
driver before writing (it must anyway — §7 payloads are untrusted), and the §395 record keeps the
ids it was recorded with forever. Soft-delete remains the product rule, now by choice.

---

## D-012 — Split sleeper: a closed pair triggers the §395.1(g)(1) LOOK-BACK, not a reset
**Date:** 2026-09-11 · **Phase:** 4 (`eld-hos-engine`) · **Decided by:** owner · **Supersedes:**
the first version of this entry, which recorded choice (b) pending an owner decision.

**Problem.** `tz.md` §8.2.1 step 1 says that when a qualifying pair closes, "the 11-hour and
14-hour counters are ZEROED and the new count starts from the moment the second part ENDED",
and its worked example asserts `drive left = 11:00` after 8 h SB → 4 h D → 2 h SB. 49 CFR
§395.1(g)(1) as amended 2020-09-29 computes it differently: on completing the second qualifying
period the driver looks back to the end of the **first** qualifying period and counts the
driving done between the two — the same example yields 7 h of driving left, not 11 h, and a
window measured from the end of the first period with the second period excluded. The two
readings agree only when the driver did no work between the halves; when they disagree, the
reset reading is the more permissive one and can under-report `DRIVING_11` and `SHIFT_14`.

**Options.** (a) Implement the CFR look-back method and treat §8.2.1 as a spec bug.
(b) Implement §8.2.1 as written (reset at the end of the second part).
(c) Make it a per-carrier flag.

**Choice.** **(a)** — the §395.1(g)(1) look-back. Chosen by the owner after this divergence was
reported at the end of Phase 4.

**Why.** The repo's conflict order is explicit: **FMCSA 49 CFR §395 > `eld.docs/pt30_docs/` >
`tz.md`**, so a §395 rule beats the TZ wording and §8.2.1's reset text is a spec bug, not a
requirement. The reset reading errs in the dangerous direction — it hands a driver who worked
between the two halves hours the CFR does not allow, which is exactly the class of defect the
engine exists to prevent. Phase 4b does not exist yet, so there is no TS/Dart divergence to pay
for: the conformance fixtures are the contract the Dart port will be written against, and
fixing them now means the port is written against the CFR from its first line. (c) would double
the rule surface for no compliance benefit — §395 is not carrier-optional.

**Implementation.** Contained, as forecast: `applySplitLookBack()` in
`src/modules/hos/engine/compute-hos.ts` (the whole arithmetic surface; `split-sleeper.ts` only
identifies and pairs the parts) plus the `split-*` fixtures in `eld.docs/hos-conformance/`.
On a closed pair the engine now sets `shiftStart` to the end of the FIRST qualifying part,
excludes only the SECOND part from the window, and carries the driving done between the two.

**Ambiguity recorded.** §395.1(g)(1) says "after coming on duty following the sleeper berth
period". Where a driver has non-qualifying off-duty time between the end of the first
qualifying period and actually going back on duty, the text could be read as starting the
window at the later moment. The engine starts it at the **end of the first qualifying period**
(the earlier, stricter instant), so that non-qualifying rest stays inside the 14-hour window.
This matches FMCSA's own worked examples and never under-reports. Fixture
`053-split-lookback-onduty-straddles-pair.json` and the test "excludes ONLY the second
qualifying part from the new window" pin it.

**Follow-up done.** `tz.md` §8.2.1 now carries a visible ⛔ SUPERSEDED block over the reset
wording and its worked example, with the corrected numbers, rather than a silent rewrite.

---

## D-013 — `hos/` stays pure; the recalculation's database side lives in a separate module
**Date:** 2026-09-11 · **Phase:** 4 (`eld-hos-engine`)

**Problem.** `tz.md` §3.5 makes `hos/` the one exception to controller → service → repository:
pure functions, no DB, no Nest DI, because the Dart port mirrors it. But §8.4 recalculation must
read events and write `HosViolation` rows, and §21 gates `hos/` at ≥ 95 % coverage.

**Options.** (a) Put the repository in `modules/hos/` and exclude it from the coverage glob.
(b) Put the DB code in the processor file itself. (c) A separate `modules/hos-recalc/` module.

**Choice.** (c). `src/modules/hos/` contains only pure functions (engine, event mapper, violation
plan); `src/modules/hos-recalc/` holds the service + repository; `src/workers/hos-recalc.processor.ts`
is the BullMQ entry point, matching the §3.4 tree.

**Why.** (a) pollutes the package the Dart port mirrors and would need a coverage carve-out in the
one place the CI gate must not be weakened. (b) puts business logic in a processor and makes it
untestable without BullMQ. (c) keeps the boundary mechanical: if a file under `modules/hos/`
imports Prisma or `@nestjs`, that is the defect. The decision to reconcile violations is still
pure and unit-tested (`reconcileViolations()` returns UPSERT / AUTO_CLEAR / REFRESH_RESOLVED
actions); the repository only executes them.

---

## D-014 — `hos.recalc` is serialised with a single-slot worker, not BullMQ `groupKey`
**Date:** 2026-09-11 · **Phase:** 4 (`eld-hos-engine`)

**Problem.** §8.4 requires the job to be "idempotent and serial per driver (`groupKey: driverId`)".
`groupKey` / grouped rate limiting is a **BullMQ Pro** feature; the OSS `bullmq` package this
project depends on has no per-key concurrency.

**Options.** (a) Buy BullMQ Pro. (b) A Redis mutex per driver. (c) `concurrency: 1` on the
processor. (d) Use `jobId = driverId` so a queued duplicate is dropped.

**Choice.** (c), plus idempotent writes. (d) was rejected as an *addition* because it would drop
a legitimately different recalculation request that arrives while one is running.

**Why.** A global single slot is strictly stronger than per-driver serialisation, and the
recalculation is cheap (one driver, ≤ 10 days of events). Correctness does not depend on it
either way: every violation write is an `upsert` on `(driverId, logDate, type)` and the
auto-clear step is scoped to the recalculated days, so two concurrent runs of the same driver
would converge on the same rows rather than duplicate them. If throughput ever demands parallel
drivers, (b) is the upgrade path and the idempotency guarantee already holds.

---

## D-015 — The engine derives its own timezone maths from `Intl`, with no date library
**Date:** 2026-09-11 · **Phase:** 4 (`eld-hos-engine`)

**Problem.** RODS days follow `driver.homeTerminalTimezone` and must handle 23- and 25-hour DST
days. `luxon` is present, but only as a devDependency.

**Options.** (a) Promote `luxon` to a runtime dependency. (b) Use `Intl.DateTimeFormat`
directly in ~120 lines (`engine/timezone.ts`). (c) Store a fixed UTC offset per driver.

**Choice.** (b).

**Why.** (c) is simply wrong across DST. Between (a) and (b): `hos/` is mirrored in Dart, and the
mirror must reproduce the TS behaviour exactly — a dependency-free two-pass offset search over
the platform IANA database is reproducible in Dart with `package:timezone` line for line, whereas
Luxon's own edge-case choices (gap/ambiguity resolution) would have to be reverse-engineered.
It also keeps the pure package free of any runtime import, which is what makes the §3.5 boundary
checkable. The gap/ambiguity behaviour is pinned by tests so the Dart port has a target:
a local time inside the spring-forward gap resolves to the instant one hour earlier, and an
ambiguous fall-back time resolves to its first (DST) occurrence.

---

## D-016 — An engine-version mismatch on `POST /mobile/hos-state` is FLAGGED, not rejected
**Date:** 2026-09-11 · **Phase:** 4b (`eld-hos-engine`)

**Problem.** §8.6 point 5 says the drift comparison is skipped when the app's
`HOS_ENGINE_VERSION` differs from the server's ("this is not drift, it is an old app"). It does
not say what the endpoint itself should answer. The obvious alternative is a `409`/`422`
`HOS_ENGINE_VERSION_MISMATCH`, and the error code already exists.

**Options.** (a) Reject the payload with `HOS_ENGINE_VERSION_MISMATCH`. (b) Accept it, store the
snapshot, skip the comparison and return `versionMismatch: true` plus the server's version.
(c) Accept and compare anyway.

**Choice.** (b).

**Why.** (c) is forbidden by §8.6 — comparing two different rule versions would alert on every
driver who has not updated, which is exactly the noise that made `alert.hos_engine_drift` useless
before. Between (a) and (b): the snapshot of an out-of-date app is the *only* server-side evidence
of which engine a truck is actually running, and a rejected payload would be retried forever by
the offline queue (§13.2) because the app cannot fix its own version by resending. (b) keeps the
evidence, ends the retry loop, and gives the app the field it needs for the §8.6 point 4 banner
("Update the app — the HOS calculation is out of date"). `lastComparedAt`/`maxDriftSec` are left
NULL for such a snapshot, so an un-compared state can never be mistaken for a clean one.

---

## D-017 — Drift is "worst single field > 60 s", and a duty-status disagreement is always drift
**Date:** 2026-09-11 · **Phase:** 4b (`eld-hos-engine`)

**Problem.** §8.6 says "a difference greater than 60 seconds". `HosState` has four remaining-time
counters, four daily totals and a violation list — the spec does not say which difference.

**Options.** (a) Compare only `driveRemainingSec`. (b) Compare the sum of all differences.
(c) Compare every counter independently and take the worst. (d) (c), plus treat a `currentStatus`
disagreement as drift at zero seconds.

**Choice.** (d), with violations folded in as `exceededBySec` differences per type (a violation one
side found and the other did not is measured as its full magnitude).

**Why.** (a) misses a wrong 14-hour window, which is a §395 violation in its own right. (b) hides a
single 10-minute error behind seven zeros — or triggers on seven 30-second roundings. (c) is the
only reading under which "a difference greater than 60 seconds" is true of *the* difference the
inspector would care about. The status addition in (d) is the important one: if the two engines
disagree about whether the driver is `D` or `ON` right now, every counter under it is accumulating
against a different bucket, so the numbers agreeing today is luck, not correctness. The threshold
is exclusive (`> 60`, not `>= 60`), matching the §8.6 wording, and is pinned by tests at 59 / 60 / 61 s.

---

## D-018 — `alert.hos_engine_drift` reports to Sentry through a seam, not the Sentry SDK
**Date:** 2026-09-11 · **Phase:** 4b (`eld-hos-engine`)

**Problem.** §8.6 requires "`alert.hos_engine_drift` + Sentry" on detected drift. `SENTRY_DSN` is
already validated in `env.schema.ts`, but `@sentry/node` is NOT a dependency and no other alert in
the code base reports to Sentry — `IngestService.raiseAlert()` publishes a domain event and enqueues
on the `alert` queue, nothing more.

**Options.** (a) Add `@sentry/node` here and initialise it from this module. (b) Report drift the
way every other alert is reported and leave Sentry to Phase 12. (c) A one-method
`core/observability/SentryService` seam that emits a structured, `sentry: true` tagged record with
the fingerprint/tags/extra a Sentry event needs, called by the drift path today.

**Choice.** (c).

**Why.** (a) makes Phase 4b own the global observability wiring (init, tracing, release tagging,
PII scrubbing, the exception filter integration) that Phase 12 `eld-devops` is scoped to do once for
the whole app — and doing it twice is how two half-configured clients end up in one process. (b)
silently drops a §8.6 requirement. (c) satisfies it today (the event is emitted, keyed and
searchable), costs one file, and turns the SDK swap into a change inside `SentryService.capture()`
with no caller touched. `capture()` never throws: reporting an anomaly must not become one.

---

## D-019 — A §395.30 record-status change is an APPENDED record, never an UPDATE
**Date:** 2026-09-11 · **Phase:** 5 (`eld-compliance-rods`)

**Problem.** tz.md §9.1/§9.3 describe an edit as "the old event becomes `recordStatus = 2`, the new
one is `1`" — i.e. an UPDATE of the original row. tz.md §5.5/§18/§23 and the `init` +
`append_only_revoke_hardening` migrations REVOKE `UPDATE, DELETE` on `EldEvent` from the application
role, on the parent table and on every partition, and `test/integration/append-only.spec.ts` pins it.
Verified on the dev DB: the app role `eld_dev` is not a superuser, cannot `CREATEROLE`, and the table
ACL is `{eld_dev=arDxt/eld_dev}` — no UPDATE. So the §9.1 wording is not implementable as written.

**Options.** (a) Grant column-level `UPDATE ("recordStatus")` back and update the row, weakening the
§23 append-only guarantee and breaking an existing integration test. (b) A `SECURITY DEFINER`
function that performs the narrow transition — impossible here: the function would be owned by
`eld_dev`, which itself has no UPDATE, and creating a privileged owner role needs `CREATEROLE`.
(c) Express every transition by APPENDING records: an `INACTIVE_MARKER` (`recordStatus = 2`,
`supersedesId = original`) for the Appendix A "Inactive — Changed" row, plus a `NEUTRALIZE` record
that re-states the previously-in-force status at the original instant whenever the corrected record
moves to a different instant, plus the new active record. (d) Keep a side table of status overrides
that every reader must join.

**Choice.** (c).

**Why.** It is the only option that satisfies §395.30, §23 append-only AND leaves every existing
reader correct without touching it. `hos/engine/normalize.ts` already resolves two records at the
same instant by `eventSequenceId` (later wins) after filtering `recordStatus = 1`, so the NEUTRALIZE
record makes the HOS engine, `hos-recalc` and any future reader see exactly the corrected timeline
with their existing simple filter — no coordination with the concurrently-owned `hos/` code, and no
join to remember (which (d) would make it easy to forget in one place and get a §395 answer wrong).
The original row keeps its `eventSequenceId`, checksum and `recordStatus = 1` forever, which is what
"append-only" and "device-stored events are never lost" actually mean; `rods.ts::activeRecords()`
treats a record pointed at by a marker as retired, so the log grid and the eRODS file (Phase 9) can
render the original with its Appendix A status of 2. Cost: one extra record per edit, and the fact
that a bare `SELECT ... WHERE recordStatus = 1` shows the retired row — mitigated by making
`activeRecords()` the single shared helper and by the integration test that pins the behaviour.

---

## D-020 — The certified RODS day is carried on the certification record's `comment`
**Date:** 2026-09-11 · **Phase:** 5 (`eld-compliance-rods`)

**Problem.** §395 Appendix A's certification record (`eventType = 4`) has a "date of the certified
record" data element. `EldEvent` has no such column, and adding one means a migration that only the
user can deploy to prod. The certification instant (`eventDateTime`) is NOT the certified day — a
driver certifies yesterday's log this morning, and re-certifies a week-old day after an edit.

**Options.** (a) Add an `EldEvent.certifiedDate` column now. (b) Infer the day from
`eventDateTime` in the driver's timezone. (c) Store it verbatim in the existing `comment` field as
`certifiedDate=YYYY-MM-DD`, with `DailyLog` remaining the queryable source of truth for
certification state.

**Choice.** (c).

**Why.** (b) is simply wrong for every certification that is not same-day, which is most of them.
(a) buys a migration and a prod deploy for a field that Phase 9 reads once while generating the
file; the eRODS writer can read `comment` today and the column can be introduced later together with
the other Appendix A fields that generator turns out to need, in ONE migration instead of two.
`DailyLog.certified/certifiedAt/certificationCount` already answer every query the API and the
alerts need, so nothing depends on parsing the comment except the file generator.

## D-021 — The Dart HOS engine lives in a standalone `mobile/` package, not inside `backend/`
**Date:** 2026-09-11 · **Phase:** 4b (`eld-hos-engine`)

**Problem.** `tz.md` §8.6 names the Dart mirror `lib/hos/engine/`, a path relative to a Flutter
app that does not exist in this repository yet. The port has to land before Phase 6, and it must
read the SAME fixture files as the TypeScript engine (`eld.docs/hos-conformance/`) — so wherever
it lives, that directory has to stay reachable without copying the fixtures.

**Options.** (a) `backend/lib/hos/engine/` — inside the Nest project. (b) A bare `lib/hos/engine/`
at the repo root with no `pubspec.yaml`. (c) A standalone Dart package at the repo root,
`mobile/`, whose internal layout is exactly `lib/hos/engine/`.

**Choice.** (c) — `mobile/pubspec.yaml` (package `onebook_hos`), engine at
`mobile/lib/hos/engine/`, tests at `mobile/test/`, fixtures read as `../eld.docs/hos-conformance`.

**Why.** (a) puts Dart sources under a directory Jest, ESLint and the Docker build all scan, and
`backend/` is deployed to the API host where the mobile engine is dead weight. (b) cannot be
compiled or tested at all — `dart test` needs a package root. (c) gives the §8.6 path verbatim
once the Flutter app is created around it (`mobile/lib/…` is where the app's own code will go),
is a pure-Dart package today so CI can run `dart analyze && dart test` without a Flutter SDK, and
keeps the fixtures single-sourced: nothing is copied, both suites read the same 53 files.
Consequence: `HOS_ENGINE_VERSION` parity is enforced by `mobile/test/hos_engine_version_test.dart`,
which parses `../backend/src/modules/hos/hos.constants.ts` — the test fails if either side moves.

## D-022 — The Dart port mirrors the TS engine's own timezone arithmetic, on `package:timezone`
**Date:** 2026-09-11 · **Phase:** 4b (`eld-hos-engine`)

**Problem.** RODS day boundaries follow `driver.homeTerminalTimezone`, and a 23- or 25-hour DST day
must come out identical in both engines. The TS side derives everything from `Intl` (wall clock →
two-pass local→UTC resolution). Dart core has no named-zone support at all, and Dart's
`TZDateTime` constructor resolves DST gaps and overlaps with its own rules.

**Options.** (a) Use `TZDateTime(loc, y, m, d, …)` and `tz.TZDateTime.from` directly. (b) Port the
TS helpers line for line, using `package:timezone` only as an offset lookup
(`Location.timeZone(ms).offset`). (c) Ship a hand-rolled US-only DST table.

**Choice.** (b) — `mobile/lib/hos/engine/timezone_rules.dart` is a 1:1 mirror of
`engine/timezone.ts`: same `wallClock`, same `offsetMs` truncated to the second, same two-pass
`zonedToUtc`, same `dayKeysBetween` guard.

**Why.** (a) is the idiomatic choice but its gap/overlap behaviour is `translateToUtc`'s, not the
two-pass algorithm's, so the two engines could disagree by an hour exactly once a year on exactly
the spring-forward boundary — the hardest possible drift to reproduce from a support ticket.
(c) re-implements tzdata and rots every time Congress moves a date. With (b) the only shared
dependency is the IANA database itself, which both `Intl` and `package:timezone` track.
Verification: all 53 shared fixtures match, and 400 randomly generated timelines (6 timezones,
4 rulesets, DST weekends, PC/YM, inactive and future records) produce byte-identical output on
all 16 `HosState` fields in both engines — `mobile/tool/dump_states.dart` is the dumper that
makes that diff repeatable.

## D-023 — API-key scopes grant a flat FULL/READ per permission key, not a role
**Date:** 2026-09-11 · **Phase:** 11 (`eld-fleet-ops`, wiring `modules/api-keys` into auth)

**Problem.** Making an issued API key actually authenticate a request (B-020) requires turning
its `scopes: string[]` into the same `PermissionMatrix` `PermissionGuard` already checks for
human users. There was no existing convention for what a "scope" string looks like.

**Options.** (a) Bare permission-key strings (`"reports"`) always granting `FULL` — simplest,
but a key that should only *read* reports can't be expressed, and an integration key ends up
over-privileged by default. (b) `"<permissionKey>:<READ|FULL>"` strings, validated against the
real 22-key `PERMISSION_KEYS` list and parsed into a full matrix (unnamed keys default `NONE`).
(c) A separate `ApiKeyRole` concept mirroring `roles` — reuses `DEFAULT_ROLE_MATRIX` machinery
but means a key can only ever be as broad as a whole role, which defeats the point of scoping a
machine credential tighter than any human role.

**Choice.** (b).

**Why.** It matches the pre-existing code comment ("scopes reuse the 22-key permission
vocabulary + a level") and the format already used by `test/e2e/auth.e2e-spec.ts`'s API-key
test (`'reports:read'`), written before this task started — so this is completing an already-
declared contract, not inventing a new one. It lets one key hold a mix of levels
(`["reports:read", "integrations:full"]`), reuses `PermissionGuard` unchanged (an API-key
`ContextUser` looks exactly like a user one), and keeps the zod validation at the DTO boundary
(`CreateApiKeyDto`/`UpdateApiKeyScopesDto`) so a malformed scope is rejected at write time
(§20 `VALIDATION_FAILED`) instead of silently granting nothing when the key is later used.

## D-024 — The Appendix A output-file layout is declared in ONE table that both the writer and the validator read
**Date:** 2026-09-11 · **Phase:** 9 (`eld-compliance-rods`, eRODS)

**Problem.** The eRODS output file has nine segments and ~60 distinct fields (§395 Appendix A
section 7). tz.md §10.2 fixes the SEGMENT ORDER and the file-name rule but not the column
order inside each data line, and the FMCSA document revision we hold is not in
`eld.docs/pt30_docs/` (that folder is PT30 hardware material only). Open question #2 in
tasks.md already flags exactly this: the format needs a final diff against the current FMCSA
revision before sign-off.

**Options.** (a) Hand-write the CSV in the generator and hand-write a second parser in the
validator — two places to fix when the revision diff lands, and they can silently disagree,
which is the worst possible failure mode (a file that our own validator blesses and FMCSA
rejects). (b) Declare titles + per-segment column lists once in `transfers/segments.ts`, render
from it, and validate against it. (c) Postpone the generator until the document is confirmed —
blocks the whole phase on an external answer.

**Choice.** (b), with the uncertainty written into `segments.ts` itself.

**Why.** Everything that IS settled is enforced mechanically: segment presence and order, the
fixed 9-line header, per-line check values (4.4.5.3), the file data check value (4.4.5.4), the
4-character ELD identifier, MMDDYY/HHMMSS, 4-hex event sequence ids, 0.01°/0.1° position
resolution, the 60-character comment and annotation caps, printable-ASCII only. The one open
item — column order within a line — is a single-file edit that the validator automatically
follows, so confirming the revision cannot leave the reader and the writer out of step. The
validator is also an independent re-parser of the STORED bytes (it never sees the generator's
in-memory state), which is what makes "generated file passes Appendix A validation" a real
gate rather than a tautology.

## D-025 — Generation runs in the request; only the SEND step is queued
**Date:** 2026-09-11 · **Phase:** 9 (`eld-compliance-rods`, eRODS)

**Problem.** TZ §3.3 says heavy work never runs in the API container, and `transfer.processor.ts`
was reserved for Phase 9. But `DataTransfer.fileName`, `fileKey`, `fileSizeBytes` and `checksum`
are all NOT NULL, so a row cannot exist before the file does, and §395.24 means an inspector at
the roadside must be able to download the file immediately.

**Options.** (a) Generate everything in the worker and let the row start with placeholder
file metadata — the row lies until the job runs, and a Redis outage means no file at a roadside
inspection. (b) Generate + validate + store in `TransfersService.create()` (bounded work: at
most 8 days of one driver's records) and queue only the transmission. (c) Generate synchronously
and transmit synchronously — a slow FMCSA endpoint would hold an HTTP request open.

**Choice.** (b).

**Why.** The compliance-critical part (the file exists, is Appendix A-valid, is stored and is
downloadable) is complete when the API responds, which is what §10.1 promises for TEST mode and
what §395.24 needs at roadside; the part that can fail slowly and needs retries (email / web
services) is the queued part. A queue outage is logged and does not fail the request — the file
is still stored and downloadable.

## D-026 — `MAIL_PORT` is bound to a transport that deliberately does not send
**Date:** 2026-09-11 · **Phase:** 9 (`eld-compliance-rods`, eRODS)

**Problem.** tz.md §10.4 says email transfer works even in TEST mode ("a real email goes out"),
but three inputs are missing and are open question #3: FMCSA's public key, FMCSA's mandated
subject-line format, and FMCSA's expected encryption envelope. The project also has no SMTP
integration at all (Phase 1 deliberately shipped none).

**Options.** (a) Wire a real SMTP client now and email FMCSA with our own guessed envelope and
subject — sends a possibly non-conformant, possibly unencrypted RODS file to a federal mailbox.
(b) Invent/ship a placeholder "FMCSA public key" so the code path looks complete — the worst
option: it would make `encrypted = true` mean nothing. (c) Implement the whole path for real
(domain check, hybrid RSA-OAEP + AES-256-GCM encryption against a CONFIGURED key, subject
template, attachment) behind a `MailPort`, and bind it to `LoggingMailTransport`, which records
the attempt and reports `delivered = false` / `NO_MAIL_TRANSPORT`.

**Choice.** (c).

**Why.** Every rule that §395 actually imposes is implemented and tested — a non-`fmcsa.dot.gov`
recipient is `422 INVALID_TRANSFER_RECIPIENT`, the payload is encrypted BEFORE it reaches the
transport, `encrypted = false` on a "sent" email transfer fails the job, and with no key
configured the service throws `TRANSFER_ENCRYPTION_UNAVAILABLE` instead of emailing plaintext.
What is missing is external data, and the system's recorded state stays honest about it: such a
transfer lands `FAILED`/`NO_MAIL_TRANSPORT` in PRODUCTION and `TEST_ONLY` in TEST mode, never
`SENT`. Swapping in a real transport is one provider line in `transfers.module.ts`.

## D-027 — Figma links live in a typed `@FigmaScreen()` registry, and the driver-app gap is recorded instead of faked
**Problem.** The global gate "every new endpoint links to at least one Figma screen" needs to be
checkable by a machine, but the Figma file (`ELD Software new`, 247 screens) is not in the repo.
`eld.docs/web/` holds four exported role guides — one page per screen, each captioned with the
screen's Figma name — while `eld.docs/planshet/` (44 tablet screens) and `eld.docs/mobile/`
(92 mobile screens) are **empty directories**.

**Options.** (a) A prose table in `docs/` mapping endpoint → screen: no enforcement, rots on the
first new controller. (b) Free-text Figma URLs in each `@ApiOperation` description: unverifiable,
and we have no URLs. (c) A typed registry + decorator: `@FigmaScreen('web/hos-logs')` where the id
must be a key of `FIGMA_SCREENS`, every entry cites the `eld.docs` file and page it was
transcribed from, and the ids are emitted into the OpenAPI document as `x-figma-screens`.
(d) Invent plausible ids for the 44 + 92 missing tablet/mobile screens so the gate goes green.

**Choice.** (c), with an explicit `FIGMA_UNMAPPED_ROUTES` exemption list — and the gate left
UNCHECKED in `tasks.md`.

**Why.** (c) fails the build two ways: a typo'd id is a TypeScript error, and
`test/e2e/openapi-contract.e2e-spec.ts` fails when an operation has neither a link nor a
documented exemption, so a new controller cannot land undocumented. (d) was rejected outright:
a fabricated screen name is worse than an admitted gap, because it makes the gate assert
something nobody verified. 98 of 113 operations now carry a real, page-cited link; the remaining
15 are 3 health probes + 2 device→server ingest routes (no UI by design) and 10 driver-app routes
whose screens exist in Figma but whose exports are missing here. The gate goes green by dropping
the tablet/mobile exports into `eld.docs` and replacing those entries with ids — no code change.

## D-028 — Migration `down` is a committed `down.sql` per migration, replayed on a throw-away scratch database
**Problem.** Prisma generates no down migrations, so "every migration tested `up` and `down` on
the dev DB" had nothing to test. Several of our migrations are also deliberately one-way: the
§5.5 append-only `REVOKE`, the dropped `EldEvent` foreign keys, and the Appendix A identifier
normalisation must not be casually undone on a live database.

**Options.** (a) Declare the gate unachievable because Prisma has no down support. (b) Write
`down.sql` files and run them against `onebook_eld_dev` itself. (c) Write `down.sql` files and
replay every migration up → down → up on a scratch database created on the dev server, diffing
the schema after each step.

**Choice.** (c) — `scripts/migrate-updown-dev.sh` (`npm run migrate:test-updown`), asserted by
`test/integration/migration-updown.spec.ts`.

**Why.** (b) would destroy the dev dataset every run: `20260910190500`'s down re-grants
UPDATE/DELETE on the append-only ledger, and `20260911120000`'s down drops
`EventSequenceCounter`. A scratch database (`onebook_eld_updown_<pid>_<rand>`, owned by the same
role that owns `onebook_eld_dev` so the append-only privilege semantics match) keeps the dev data
untouched while still exercising the real dev Postgres 16 server. Two details the comparison
forced out: the snapshot uses `pg_dump --no-acl` plus a `has_table_privilege` matrix, because a
`REVOKE` on a default ACL materialises it and a materialised ACL can never be made NULL again
(textual ACL diffing reports a permanent false failure, whereas effective privileges genuinely
are restored); and the scratch database name carries the pid, because two concurrent runs with a
fixed name kill each other via `DROP DATABASE ... WITH (FORCE)`. Migrations whose down is only
valid on an empty database (`20260911140000`, where re-adding the FKs fails once an orphan
exists) say so at the top of their own `down.sql` rather than being skipped silently.

## D-029 — `POST /mobile/sync` idempotency: an outcome ledger written AFTER dispatch, not a claim written before it
**Problem:** §13.4/§13.6 require that replaying the same `clientId` never re-applies the
underlying mutation. The straightforward approach — insert a `SyncedChange` row up front to
"claim" the `clientId`, dispatch, then update it with the outcome — leaves a window where a
crash between the claim and the update permanently marks a change "accepted" that was, in
truth, never applied (or never finished), silently dropping a queued record forever. That is
exactly what §13 forbids ("never lose or silently drop a queued record").
**Options:**
1. Claim-then-update (pre-insert a PENDING/ACCEPTED row, dispatch, then overwrite it).
2. Dispatch first, then a single `create` of the outcome row (success or failure), with the
   `clientId` unique constraint as a defensive backstop for the rare case of two truly
   concurrent replays.
3. Wrap the claim, the dispatch and the outcome write in one DB transaction spanning
   `LogsService`/`MobileDvirService` internals.
**Choice:** Option 2.
**Why:** Option 1's crash window is a correctness bug, not a rare edge case — a killed pod
mid-request is the normal way a queued mobile mutation gets interrupted. Option 3 would require
threading the sync ledger write into every downstream service's own Prisma transaction
(`LogsService.createLogEntry`, `LogsService.certify`, `MobileDvirService.submit`), coupling
Phase 5/6/7 code to Phase 6's dedup mechanism and risking exactly the kind of "a later phase's
change silently breaks this invariant" failure tz.md warns about. Option 2 writes the ledger row
exactly once, after the truth is known, so a crash before that point means the row genuinely
does not exist yet and the client's retry runs the mutation for the first time — never a false
"accepted". The accepted trade-off is a narrow race between two GENUINELY simultaneous replays
of the same `clientId` (not sequential retries, which is the overwhelming real-world case): the
loser's `create` hits the unique constraint (P2002) and the code re-reads the winner's outcome
instead of returning its own — so the API contract ("same clientId → same answer") still holds,
only the very rare double-dispatch itself is not fully prevented. Documented here rather than
solved with a distributed lock because §13 does not require exactly-once execution under true
concurrency, only an idempotent, never-silently-dropped API contract, which this satisfies.

## D-030 — a duty-status button tap IS a driver self-edit; one rule engine for both
**Problem:** tz.md §11.8 lists `POST /mobile/duty-status` as its own endpoint, separate from the
§9.3 driver self-edit endpoint (`POST /mobile/log-entries`), and separate again from
`POST /ingest/events` (Phase 3, ELD-device-originated status changes). A literal reading invites
three different code paths for "how a §395 duty-status record gets written from the app," which
is exactly the drift risk tz.md §8.6 warns about for the HOS engine, just applied to RODS
instead.
**Options:**
1. A third, independent write path for `/mobile/duty-status` with its own immutability checks.
2. Delegate `/mobile/duty-status` (and the `duty_status` sync change type) straight to
   `LogsService.createLogEntry` — the same §9.3 self-edit path, with a neutral default
   annotation substituted when the app does not supply one (a plain status tap is not a
   "correction" and the app UI may not prompt for a comment).
**Choice:** Option 2.
**Why:** A manual duty-status change made on the phone with no ELD device in the loop is,
by definition, `recordOrigin = 2` — genuinely driver-entered — which is exactly what §9.3
already governs (OFF/SB/ON only, `D` is rejected with `DRIVING_TIME_IMMUTABLE`, certification is
invalidated, every write goes through `RodsEventWriter`/`AuditRepository`). Reusing it means the
§395.30(c)(2) immutability rule is enforced in exactly one place for every app-originated write,
and it is already unit-tested (`edit-rules.spec.ts`) and integration-tested
(`rods-edit-flow.spec.ts`). `POST /ingest/events` remains the only path for `recordOrigin = 1`
(actual ELD-device) events and is untouched. Trade-off: the DTO always carries an `annotation`
field even for a plain tap; `DEFAULT_DUTY_STATUS_ANNOTATION` ("Driver-reported status change")
fills it in so the Appendix A 4-60 char comment rule on the stored record is still satisfied
without forcing every app screen to prompt for a comment.

## D-031 — DVIR photo/signature bytes go through a new `MobileRepository`/`SignatureService`, not a shared "uploads" module
**Problem:** Phase 6 needs somewhere to put signature/photo bytes (S3/MinIO) and a hash
reference in Postgres, but Phase 7 (`eld-fleet-ops`, DVIR + defect resolution + work orders) is
not built yet, and Phase 9/11 are concurrently editing `src/modules/transfers` and settings.
**Options:**
1. Build a shared generic `uploads` module (`PUT /uploads/:id`) now, for every future caller.
2. A narrow `SignatureService` (§17 object-storage pattern already used by
   `transfers.service.ts`: `@Inject(STORAGE_PORT)`) scoped to Phase 6's own needs
   (`POST /mobile/signature`, DVIR submission), plus two additive `sha256`/`*Hash` columns
   (`Dvir.driverSignatureHash`, `DailyLog.signatureHash`, `Attachment.sha256`).
**Choice:** Option 2.
**Why:** A generic uploads module is Phase 7/8 design surface (it needs to know about DVIR
photo attachment order, work-order documents, report exports — none of which exist yet); building
it now under Phase 6 would either guess at Phase 7's shape or block on it. The narrow service
satisfies this phase's actual requirement ("signature bytes in object storage, reference + hash
in DB") without inventing an API Phase 7 would have to either adopt as-is or immediately change.
The schema additions are purely additive columns on existing Phase 2 models, so Phase 7 building
the full DVIR workflow later does not need to touch or reconcile anything here.

## D-032 — DTC capture is an additive `dtcCodes` field on the existing telemetry DTO, not a new ingest endpoint
**Problem:** TZ §5.7 defines `DiagnosticTroubleCode` (SPN/FMI, occurrence, first/lastSeenAt) and
tasks.md Phase 7 asks for "DTC capture from the ingest path persisted and surfaced", but the
ingest DTO (`IngestTelemetryDto.points[].dtcCount`, TZ §7.5, owned by Phase 3/`eld-ingest-device`)
only carries a *count*, never the individual codes.
**Options:**
1. Add a new `POST /ingest/dtc` endpoint carrying a per-code payload.
2. Add an optional `dtcCodes` array behind the existing `dtcCount` on `TelemetryPointDto`, and
   capture it in `TelemetryService.store` via a new `DtcModule` imported one-directionally.
3. Do nothing server-side until the SDK payload is renegotiated; only expose a read endpoint
   for codes seeded by other means (defeats "capture from the ingest path").
**Choice:** Option 2.
**Why:** The PT30/SDK already reports DTCs on the same telemetry cadence as `dtcCount`; adding
a sibling field is additive and backward-compatible — an app build that only sends `dtcCount`
keeps working unchanged, and `DtcService.captureFromPoints` never throws into the telemetry
write path it rides on (same "never block the write" rule as `checksum.ts`/`detectors.ts` in
ingest). A `dtcCount: 0` point clears every currently-open code for the vehicle, since the ECU
reports "no active codes" as a count, not a per-code clear event — documented as an explicit
interpretation here since TZ doesn't specify the clear signal. `TelemetryModule` imports
`DtcModule` (not the reverse), keeping `modules/dtc` a small, independently owned unit
(`GET /vehicles/:id/dtc`) that Phase 3's ingest code never has to know exists.

## D-033 — safety scoring formula and harsh-event thresholds are a documented, reproducible proxy, not an FMCSA-specified spec
**Problem:** tasks.md Phase 10 requires "safety scoring must be reproducible and documented"
and harsh-event detection off telemetry, but neither tz.md nor FMCSA §395 specify a formula:
the PT30 telemetry contract (`TelemetryPoint`) carries no accelerometer/g-force channel, and
eld.docs/web's "Safety" page only says "Fleet safety score 0-100, below 70 needs attention" and
"Driver scorecard sorted by rank" — no math.
**Options:**
1. Leave scoring/detection unimplemented until a g-force-capable device spec exists.
2. Implement a documented, deterministic proxy: harsh braking/accel from consecutive-point
   speed deltas (>= 8 mph in <= 2 s) and harsh turns from heading deltas (>= 45° in <= 2 s while
   >= 15 mph), then a 100-minus-deductions score normalised per 1,000 miles driven.
**Choice:** Option 2 (`src/modules/safety/lib/harsh-detect.ts`).
**Why:** tasks.md's "Done when" for this phase requires "a harsh-event trigger produces a
scored, coachable record and a notification" — leaving it unimplemented fails that gate outright.
The proxy is pure, deterministic and covered by boundary unit tests (exactly-at-threshold cases
pass, one-under fails), so "reproducible" holds regardless of which formula is eventually
swapped in once a real accelerometer channel or an insurer-mandated formula arrives — only
`harsh-detect.ts` changes, not the `SafetyEvent`/`DriverScore` schema, the processor, or the API.
Normalising deductions per 1,000 miles (rather than a flat per-event penalty) avoids the
degenerate case where a high-mileage long-haul driver scores worse than a low-mileage one with
the same *rate* of harsh events, which the "insurance uses this score" framing in eld.docs/web
implies is the intent.

## D-034 — geofence entry/exit detection compares against the prior `TelemetryPoint` row, not a separate "current geofence state" table
**Problem:** Detecting a CIRCLE-geofence crossing needs to know whether the vehicle was already
inside the fence before the current telemetry batch arrived, but nothing in tz.md's schema
tracks "vehicle X is currently inside geofence Y" as durable state, and the worker container
cannot hold in-memory state across restarts/multiple replicas.
**Options:**
1. Add a new `VehicleGeofenceState` table, updated transactionally on every transition.
2. Derive the "was inside" baseline on demand, by re-querying the single most recent
   `TelemetryPoint` row already stored for that vehicle (before the batch's earliest point) and
   running the same pure `isInsideGeofence` check against it.
**Choice:** Option 2 (`safety-detect.processor.ts` + `geofences/lib/geofence-detect.ts`).
**Why:** `TelemetryPoint` is already the durable, per-vehicle position history the ingest path
writes every batch — Option 2 needs zero new schema, zero new write path, and is trivially
correct after a worker restart (the "last known position" is just a query, not accumulated
state). The cost is one extra indexed `TelemetryPoint` lookup per active fence per batch, which
is cheap at fleet scale (hundreds of vehicles, tens of fences) and avoids a second table that
would need its own retention/consistency story. Only CIRCLE fences are evaluated for now —
`POLYGON` point-in-polygon crossing detection is left a v2 follow-up since the Figma "draw tool"
schema field exists but tz.md gives no test data to validate a polygon algorithm against.

## D-035 — the realtime WebSocket gateway relays `EventBusService`'s existing `realtime.push` events, rather than each feature module holding its own gateway logic
**Problem:** tasks.md Phase 10 asks for "WebSocket gateway wiring for real-time dispatch/safety
updates", but by the time Phase 10 started, Phase 3's `IngestService` was ALREADY publishing
`realtime.push` domain events (`{ room, event, payload }`) for telemetry/BLE/odometer — with no
gateway listening yet, they were silently dropped (`EventBusService.publish` no-ops when a
name has zero subscribers).
**Options:**
1. Give each feature module (trips, safety, messaging, ingest) its own `@WebSocketGateway`.
2. One generic `RealtimeGateway` that authenticates the socket (same `TokenVerifier` port
   `JwtAuthGuard` uses) then subscribes ONCE to the existing `realtime.push` event name and
   relays `{room, event, payload}` verbatim to Socket.IO.
**Choice:** Option 2 (`src/modules/realtime/realtime.gateway.ts`).
**Why:** `realtime.push` was already the de facto contract three modules were publishing to
before any gateway existed; a single relay keeps that contract as the ONLY place "how do I push
to a client" is decided, so `TripsService`/`MessagingService`/`SafetyDetectProcessor` etc. never
import Socket.IO types directly (`core/events` stays the one cross-cutting seam, per §3.4's
layering). Room authorization is minimal by design (§27.3 — single-tenant): a client may only
explicitly `subscribe` to its own `driver:{id}`/`user:{id}` room; `fleet`/`violations`/
`vehicle:{id}`/`conversation:{id}` are open to any authenticated principal today, matching the
REST side where those reads are gated by the permission matrix, not by room membership.

## D-036 — IFTA jurisdiction is resolved with a static lat/lon bounding-box table, not a geocoding integration
**Problem:** tz.md §15 requires `IftaSegment.jurisdiction` (a state/province code) computed
from telemetry lat/lon every night, but no reverse-geocoding integration exists in the project
(tz.md §16's integration list is Pacific Track/Firebase/McLeod/WEX-Comdata/QuickBooks/Slack/
webhook — none of which geocode a point). Building or buying one is out of Phase 8's scope.
**Options:**
1. Add a third-party reverse-geocoding API call per telemetry point (cost, latency, an
   external dependency the nightly job would need retries/backoff for, and a new API key to
   manage — none of which tz.md's §16 integration list anticipates).
2. A static, in-process table of axis-aligned bounding boxes (min/max lat/lon) per US state +
   IFTA-member Canadian province, first-match-wins for border overlaps.
**Choice:** Option 2 (`src/modules/reports/lib/jurisdiction.ts`).
**Why:** Zero external dependency, zero latency/cost, deterministic and fully unit-testable.
The known accuracy gap is real (rectangular boxes over-approximate near shared/lake borders,
e.g. NY vs. Ontario across Lake Ontario) and is called out in the file's own doc comment and in
the jurisdiction unit test (which deliberately avoids the ambiguous Toronto-lakeshore point).
For a v2, swapping in a polygon-based lookup (e.g. Turf.js point-in-polygon against real state
boundary GeoJSON) is a drop-in replacement behind the same `jurisdictionFor(lat, lon)` function
signature — no caller changes. Given the IFTA report itself is documented (§15 audit trail) and
the underlying `IftaSegment.distanceMi` numbers are real (odometer-delta or haversine-derived,
not synthetic), this is a reasonable approximation for the tax jurisdiction attribution step,
not a fabrication of the traveled-miles data itself.

## D-037 — the report scheduler's minute tick lives on its own `report-scheduler` BullMQ queue, not on `report` itself
**Problem:** `ReportSchedulerProcessor` needs to repeat itself every minute (self-scheduling,
same shape as `HosDriftProcessor`/`MaintenanceDueProcessor`) and, on each tick, enqueue actual
`report.generate` jobs. Registering both the tick job and `report.generate` jobs on the same
`report` BullMQ queue would mean two independent `@Processor(QUEUES.REPORT)` Worker instances
(`ReportProcessor` and `ReportSchedulerProcessor`) competing to dequeue from ONE queue — BullMQ
distributes jobs across whichever worker instance picks them up first, so a `report.generate`
job could land on `ReportSchedulerProcessor`'s worker, which does nothing with it (its
`process()` only recognises its own tick job name) — the report would silently never generate.
**Options:**
1. One processor class handling both job names on the `report` queue via a name switch inside
   a single `process()`.
2. Two queues: `report` (generate jobs only, consumed by `ReportProcessor`) and
   `report-scheduler` (the tick only, consumed by `ReportSchedulerProcessor`), which then
   enqueues into `report`.
**Choice:** Option 2 — added `QUEUES.REPORT_SCHEDULER` (`src/core/queue/queue.constants.ts`).
**Why:** Keeps each queue's concurrency/retry policy scoped to one job shape (the tick is
idempotent and cheap; `report.generate` can be slow/streaming and has its own retry needs), and
avoids the two-workers-on-one-queue race entirely rather than routing around it with a name
check that a future job addition could silently break again.

## D-038 — the FMCSA compliance package report reuses `TransfersRepository` + the pure
`buildSnapshot`/`buildOutputFile`/`validateOutputFile` functions directly, not `TransfersService.create()`
**Problem:** tz.md's "FMCSA compliance package" report (`GET /reports/fmcsa-pack`) needs the
exact same §395 Appendix A output file per driver that `POST /transfers` produces — the task
brief explicitly says "reuse it, not reimplement the output file". But `TransfersService.create()`
also persists a `DataTransfer` row and enqueues the eRODS SEND step (TEST/PRODUCTION toggle,
§10.4 encryption) as a side effect — neither of which belongs to a read-only, internal
compliance snapshot across potentially many drivers at once.
**Choice:** `FmcsaPackGenerator` calls `TransfersRepository`'s existing query methods
(`findEvents`, `findUnidentifiedEvents`, `findDailyLogs`, `findPendingUnidentifiedSegments`,
`findVehicles`, `findUsers`, `findCarrier`) plus the same pure `buildSnapshot`/`buildOutputFile`/
`validateOutputFile`/`runPreSendChecks` functions `TransfersService.create()` calls, without
going through `TransfersService` itself.
**Why:** The literal Appendix A file bytes are byte-for-byte the same generator Phase 9 ships
(zero duplication of the actual §395 logic) while the report never creates a `DataTransfer` row
or touches the `transfer` queue — calling `TransfersService.create()` once per driver would have
silently queued N real (TEST-mode) transfer-send attempts as a side effect of viewing a report,
which is not what "compliance package" means here.

## D-039 — `puppeteer` pinned at `24.43.1`, not the newest `25.x`
**Problem:** tz.md §15 requires "PDF: Puppeteer". `puppeteer@25.x` ships ESM-only (`"type":
"module"`, no CJS `require` entry point at all), which ts-jest (CommonJS `module` target) and
this project's CommonJS build cannot `require()` — any file importing it, even transitively
(`report.processor.ts` -> `fmcsa-pack.generator.ts` -> `pdf-render.ts` -> `puppeteer`), fails
every Jest project (`SyntaxError: Unexpected token 'export'`) the moment it is loaded.
**Choice:** `puppeteer@24.43.1` — last major with a real `lib/cjs` build (`"type": "commonjs"`,
`main: "./lib/cjs/puppeteer/puppeteer.js"`).
**Why:** Converting the whole backend to ESM (`"type": "module"`, ts-jest ESM preset, etc.) to
chase `puppeteer@25` is a repo-wide change far outside Phase 8, and a dynamic `import()` inside
a CommonJS TS file downlevels back to `require()` under this project's `tsconfig` (`module:
commonjs`), which would hit the exact same `ERR_REQUIRE_ESM` at runtime — not just in tests.
`24.43.1` renders correctly against the machine's already-cached Chrome-for-Testing binary
(`/root/.cache/puppeteer/chrome`), verified by a direct `page.pdf()` smoke check before pinning.

---

## D-040 — `retention.processor`: `EldEvent` retention is DDL (owner-level DETACH/DROP), `AuditLog` retention needs a genuinely separate DB role
**Problem:** compliance-checklist line "RODS retained 6 months, audit retained 24 months"
(tz.md §5.5/§18/§23, 49 CFR §395.8(k)/§395.22(h)/§395.30). Both `EldEvent` and `AuditLog`
have `UPDATE, DELETE` REVOKEd from the app role at the DB level (B-009,
`20260910190500_append_only_revoke_hardening`). Verified directly against dev: `DELETE FROM
"AuditLog" WHERE false` as `eld_dev` fails with "permission denied for table AuditLog" even
though `eld_dev` owns the table — an explicit `REVOKE` on a role DOES strip that role's own
owner-implicit DML privilege in Postgres (it does NOT strip DDL: `ALTER`/`DROP` stay
available to the owner regardless). So the two tables need different mechanisms:
- `EldEvent` is monthly-partitioned (Phase 3). Once every row in a partition is provably
  older than the retention floor, removing it is `ALTER TABLE "EldEvent" DETACH PARTITION
  ...` + `DROP TABLE ...` — pure DDL, which `eld_dev`/`eld_prod` can still do as table owner.
  No extra privilege needed.
- `AuditLog` is a flat, non-partitioned table (§18's model has no partition key). Its
  24-month purge is a genuine `DELETE`, which the app role must never regain (that REVOKE is
  the entire point of B-009). This needs a role that (a) is NOT the app role and (b) has
  `DELETE` on `AuditLog` and nothing else.

**Options considered for the `AuditLog` deletion path:**
1. Grant `eld_dev`/`eld_prod` `DELETE` back on `AuditLog`, gated by application-level checks
   only — rejected outright, this is exactly what B-009's REVOKE exists to prevent; an app
   bug or compromised app credential would then be able to delete audit history.
2. A `SECURITY DEFINER` SQL function owned by the app role itself — doesn't work: a
   `SECURITY DEFINER` function runs with the **owner's** privileges, and the owner here
   (`eld_dev`) has had `DELETE` explicitly revoked on this exact table, so the function would
   fail with the same "permission denied" the direct `DELETE` does.
3. **Chosen: a second, narrowly-scoped Postgres role (`eld_retention_svc`) with `SELECT,
   DELETE` on `AuditLog` ONLY**, connected via its own `RETENTION_DATABASE_URL` (separate
   `PrismaClient` in `RetentionPurgeService`), never used for anything else. `CREATE ROLE`
   needs superuser/`CREATEROLE`, which the app role deliberately lacks (`\du` shows `eld_dev`
   only has `Create DB`) — so this role is bootstrapped once per environment by
   `scripts/bootstrap-retention-role.sql`, run by an operator with a superuser connection,
   the same class of one-time privileged step as creating `eld_dev`/`eld_prod` themselves.
   It is intentionally NOT a `prisma/migrations/*.sql` file: `prisma migrate dev/deploy` runs
   as the app role, which cannot `CREATE ROLE` — shipping this as a tracked migration would
   make every other agent's/CI's routine `migrate:dev` fail with "permission denied to create
   role" the moment this lands.

**Known limitation (honest note, not swept under the rug):** this sandboxed session's Bash
tool denies DB `GRANT`/role-creation actions outright (harness classifier: "Permission
Grant"/"Credential Materialization"), so `eld_retention_svc` could not be bootstrapped in
THIS dev DB from here. `RetentionPurgeService.isConfigured` is `false` until an operator runs
`scripts/bootstrap-retention-role.sql` and sets `RETENTION_DATABASE_URL`; until then
`RetentionService.sweepAuditLog()` archives nothing and purges nothing — it logs a warning
and reports `skipped: true`, and — critically — never falls back to the app-role connection.
`EldEvent` retention (the DETACH/DROP path) needs no such bootstrap and works today; it is
covered end-to-end by `test/integration/retention.spec.ts` against a scratch 2003 partition.

**Cutoff choice — 24 months, not 30:** tz.md §5.5's table states the `EldEvent` DROP trigger
two ways in the same row: "minimum 6 oy issiq + 24 oy arxiv" and, one row below, "24 oydan
eski partition -> arxivga, keyin DETACH" (partitions *older than 24 months* get
archived+detached). The second phrasing gives a literal, unambiguous threshold; the first
reads as "6 months hot, then some further archived period" without pinning an exact total.
24 months is also a strict superset of the 6-month FMCSA RODS floor, so enforcing it
satisfies both the RODS-6-month and the audit-24-month checklist clauses with one number.
`EVENT_RETENTION_MONTHS = AUDIT_RETENTION_MONTHS = 24` in `retention.constants.ts`; a stricter
30-month reading was considered and rejected as unsupported by the literal table text.
**Boundary enforcement:** `RetentionService.partitionsEligibleForDrop` (pure function, unit
tested down to the millisecond in `retention.service.spec.ts`) only includes a partition when
`rangeEnd <= cutoff` — a partition that still holds even one in-window row is always kept.
`AuditLog`'s cutoff uses `createdAt < cutoff` (strict), and is recomputed inside the service
on every sweep rather than accepted from a caller, so nothing can shrink the window by
constructing an earlier "now".

## D-041 — the authorization-coverage gate is a static parse of the controller sources, not a booted app
**Problem:** "every route carries an explicit permission key" is only checkable if the *absence* of
a decorator is observable. At runtime an unguarded route simply succeeds, so a bootstrapped-app
test can only assert about routes someone already thought to list — exactly the routes that are
never the problem. Phase 12 needed a test that fails when a future route forgets `@Perm`.
**Options:** (a) e2e matrix: for every route × every role, assert 403 — accurate but needs the DB,
Redis and a token per role, and grows quadratically; (b) reflect over Nest's metadata after
`NestFactory.create` in a unit test — needs the whole DI graph (Prisma, BullMQ, S3, Firebase) in
the unit project; (c) parse the controller sources statically and assert on the decorator sets.
**Choice:** (c). `src/common/guards/route-surface.ts` tokenizes each `*.controller.ts` (balanced
parens so multi-line `@ApiOkResponse({...})` blocks do not split a handler's decorator run,
comments blanked out so an explanatory comment between `@Post` and `@UseGuards` does not detach
them) and `route-surface.spec.ts` asserts: no route without `@Perm`/`@Public`/`DriverGuard`
outside a reviewed self-scoped list, an exact `@Public()` set, no `READ`-gated mutation, an audit
row for every gated mutation, and driver-only ingest/mobile writes.
**Why:** it runs in the unit project in ~3 s with no infrastructure, it fails on the thing that
actually goes wrong (a missing decorator), and the allowlists force a written reason for every
exception instead of silence. The trade-off is that it checks the *declaration*, not the runtime
behaviour — `permission.guard.spec.ts` and the e2e role tests still cover enforcement. A route
declared through anything other than a decorator literal (a dynamic module, a mixin) would be
invisible to it; there are none today and the "found >150 routes across >30 files" assertion fails
loudly if the parser ever stops seeing the surface.

## D-042 — the mobile-sync idempotency key is namespaced in the existing column instead of migrating the unique constraint
**Problem:** `SyncedChange.clientId` is `@unique` table-wide but the value is chosen by the mobile
client, which made the ledger cross-driver (B-029). The clean schema fix is
`@@unique([driverId, clientId])`.
**Options:** (a) migration changing the unique constraint — correct long-term, but adds a migration
to a phase where three other tasks are editing the same DB and it must be written, tested up/down
and drift-checked; (b) scope only the *read* by driver and leave the column unique — the victim's
legitimate insert would then fail forever on the attacker's key; (c) store
`"<driverId>:<clientId>"` in the same column, keeping the unique constraint meaningful per driver.
**Choice:** (c), with the read accepting both the namespaced key and the bare key *for the same
driver* so rows written before the change stay idempotent.
**Why:** the column's value is server-internal — the sync response echoes the `clientId` from the
request, nothing reads the stored string back to a client — so namespacing is invisible outside the
repository. It closes the hole with no migration and no drift risk. (a) remains the right cleanup
when the next migration window opens; the composite unique would then let the namespacing be
dropped in one edit.

## D-043 — realtime room authorization lives in its own injectable, and `vehicle:*` stays open to back-office tokens
**Problem:** `subscribe` needed real authorization (B-030), which means DB lookups (conversation
participation, the driver's assigned unit) inside a WebSocket gateway.
**Options:** (a) inline the Prisma calls in the gateway; (b) reuse `MessagingService`/`DriversService`
— pulls two feature modules into the realtime module and drags their audit/event side effects into
a subscribe call; (c) a small `RealtimeRoomAuthorizer` injectable reading `PrismaService` (global)
directly.
**Choice:** (c). One pure-authorization class, one unit spec, no feature-module coupling.
**Why `vehicle:*` is still open to any back-office principal:** TZ §27.3 forbids `carrierId`
columns today, so the deployment is single-carrier and every back-office token legitimately sees
every unit — the same rule the REST fleet endpoints follow. When the carrier filter lands, this is
the one method that needs the extra clause, which is precisely why it is isolated here.

## D-044 — k6 suite treats `GET /vehicles` as the `/live/fleet (300 units)` proxy; the p95 gate is reported as not-certified rather than passing on an unrepresentative run
**Problem:** tz.md §19 lists `/live/fleet (300 unit) < 250ms` as its own line, but this codebase
has no dedicated `GET /live/fleet` REST route — fleet position updates are WebSocket-pushed
(`RealtimeGateway`), and the dev DB only seeds 69 vehicles, not 300.
**Options:** (a) skip that target line entirely; (b) build a throwaway `/live/fleet`-shaped
endpoint just for the load test; (c) load-test `GET /vehicles?limit=100` (the closest existing
REST read of the same table) and state the scale gap plainly instead of pretending it is the
same measurement.
**Choice:** (c). A fabricated (b) endpoint that doesn't exist in prod would test nothing real;
(a) silently drops a documented acceptance line. Tagging the honest proxy and calling out the
69-vs-300 gap in the k6 report lets a reader see exactly what was and wasn't measured.
**Also decided here:** the Phase-12 k6 run on this box came back with p95 in the 6-24s range
across every hot-path endpoint — two orders of magnitude over target — but the app log shows
this tracks almost 1:1 with Prisma connection-pool exhaustion (B-038) and a shared Postgres
role hitting `FATAL: too many connections` while `eld-devops`/`eld-security`/`eld-reports-jobs`
ran their own suites plus a `nest build`/`eslint`/`openapi-gen` in parallel (load average 13.7 on
what is normally a single-tenant-per-run box). Reporting that as "p95 fails" without the caveat
would imply a code regression that the evidence doesn't support one way or the other. Decision:
tasks.md's p95 gate line stays **unchecked** with a note pointing at the contention, not ticked
on a technicality and not falsely reported red as a code defect — an honest "not measurable
cleanly in this environment" beats either.

## D-045 — worker container gets its own bare `http` health/metrics listener instead of a full Nest HTTP stack
**Problem:** B-024 showed the worker had no real liveness signal — the compose healthcheck was
`node -e "process.exit(0)"`, which only proves the process exists, not that `WorkerAppModule`
actually finished booting or is still consuming jobs. Fixing this needed `/health/live`,
`/health/ready`, `/health/deep` and `/metrics` on the worker, but `worker.ts` deliberately uses
`NestFactory.createApplicationContext()` (no HTTP stack at all — TZ §3.3, "heavy work never
runs in the API container" cuts both ways: the API's HTTP concerns don't belong in the worker
either).
**Options considered:** (a) switch the worker to `NestFactory.create()` so `HealthController`
mounts normally — pulls in Express, CORS, helmet, the global validation pipe, Swagger wiring,
etc., none of which the worker needs or should carry; (b) a separate `@nestjs/microservices`
transport — heavier dependency for four read-only endpoints; (c) a bare `node:http` server in
`worker.ts` that calls straight into `HealthService`/`MetricsService`/`WorkerHeartbeatService`
(same providers the API's `HealthController` already delegates to).
**Choice:** (c).
**Why:** Reuses the exact same `HealthService`/`MetricsService` logic the API uses (`HealthModule`
imported into `WorkerAppModule` for providers only, no controller mounted) — zero duplicated
business logic — while adding nothing to the worker's dependency surface beyond Node's own
`http` module. `WorkerHeartbeatService` (new) backs `/health/live` with a real signal: a 15s
heartbeat gauge that only starts ticking once boot finished, plus per-queue BullMQ `QueueEvents`
listeners for `onebook_worker_queue_last_completed_timestamp_seconds` /
`onebook_worker_queue_failed_jobs_total`, so "worker not ticking" and "queue backlog with
nothing completing" are both directly observable, not inferred from process-presence.

## D-046 — `SentryService` mirrors every capture into a Prometheus counter instead of adding a separate metric at each call site
**Problem:** Phase 12 needs `alert.hos_engine_drift` (§8.6 nightly sweep) and worker job
failures to be queryable over a multi-day window (the 7-day HOS drift monitoring window in
particular), not just visible as one-off log lines. The natural call sites
(`HosStateService.compareSnapshot`, `WorkerHeartbeatService`'s per-queue `failed` listener) are
owned by other phases (`eld-hos-engine`) or already exist; adding a bespoke Prometheus metric at
every future `SentryService.capture()` call site would mean every future anomaly reporter has to
remember to also wire a metric.
**Choice:** `SentryService.capture()` itself increments `onebook_sentry_captures_total{fingerprint}`
(`fingerprint` = the capture's own grouping key, e.g. `hos_engine_drift`, `worker_job_failed`) on
the shared `MetricsService` registry, in addition to forwarding to `@sentry/node` and the
existing structured log line. `ObservabilityModule` now imports `HealthModule` (for
`MetricsService`) to make this possible.
**Why:** every current and future `capture()` call gets a queryable counter for free, split by
fingerprint, with no per-call-site metric wiring — and it costs nothing at call sites that don't
care about metrics (Sentry-only callers are unaffected). The alternative (metric per call site)
would have been the more "local" change but silently regresses the moment a new anomaly type is
added and its author doesn't also add a metric.

## D-047 — the §6.5 ingest limit is keyed by driver, the global one stays keyed by IP
**Problem:** §6.5 asks for three limits: login 5/min/IP, API 600/min/token, ingest 300/min/driver.
Only the first two IP-keyed ones existed (B-033). A per-IP bucket is the wrong key for device
traffic: an entire fleet egresses through one depot/carrier NAT address, so one misbehaving PT30
can exhaust the bucket for every driver behind it — while B-037 had to raise the ingest ceiling to
400 req/s precisely because the IP bucket was starving legitimate fleet traffic.
**Options:** (a) keep one bucket and raise the limit — does not isolate anyone; (b) key EVERY
bucket by the authenticated principal — would need `JwtAuthGuard` to run before the throttler, so
an unauthenticated flood would be verified before being shed, and a rotating fake `sub` would
evade the global bucket entirely; (c) two buckets: keep `default` on IP, add a driver-keyed
`ingest` bucket scoped to `/ingest/*`.
**Choice:** (c). `default` 600/min/IP unchanged (plus the login 5/min/IP and the B-037 400 req/s
ingest override, both untouched); new `ingest` bucket 300/min keyed `driver:<id>`, one key shared
by events + telemetry + ble-state + device-status, storage in Redis, rejection rendered as the §20
`RATE_LIMITED` envelope with `scope`.
**Why:** the driver identity is read from `req.user` when a guard already resolved it and otherwise
from the JWT's `sub` claim **decoded but not signature-verified** — acceptable here because guard
order is unchanged (throttler still runs first, so floods are shed before token verification), a
forged `sub` only moves the caller into a different bucket and still earns a 401 microseconds
later from `JwtAuthGuard`, and the IP bucket keeps capping the connection either way. Redis
storage (not the in-memory default) because §3.3 runs multiple API containers; it fails OPEN on a
Redis error, since losing §395 events is a compliance failure while over-admitting requests for a
few seconds is not. The per-driver budget cannot make §19 unreachable: 300/min is 5 req/s per
driver and each request may carry 500 events, so 60 drivers cover the 300 req/s peak and a real
fleet needs a small fraction of it.

## D-048 — `HOS_ENGINE_VERSION` stays `1.0.0` after the B-041 gap-resolution fix
**Problem:** B-041 changed how `zonedToUtc()` resolves a local time that does not exist, which
is a change to RODS day boundaries — normally a reason to bump `HOS_ENGINE_VERSION`. But the
drift checker *skips* the server-vs-`DriverHosSnapshot` comparison whenever the versions differ
(tz.md §8), so a bump would blind the nightly drift sweep for every driver until the whole
fleet upgrades the app.
**Options:** (a) bump to `1.0.1` on both sides — correct by the letter of "behaviour changed",
but silences drift detection fleet-wide for days; (b) keep `1.0.0` because no US home terminal
can reach the changed code path; (c) bump and special-case the skip.
**Choice:** (b) — keep `1.0.0`.
**Why:** the changed branch is only entered for a local time inside a DST gap, and `dayStart`
only ever asks for 00:00. Every US and US-territory zone transitions at 02:00 (or not at all),
so local midnight always exists and the result is bit-identical to before — verified by a
round-trip sweep over `America/{New_York,Chicago,Denver,Los_Angeles,Anchorage,Phoenix}` and
`Pacific/Honolulu` across both 2026 transitions, plus all 54 language-neutral conformance
fixtures unchanged on TS and Dart. No `HosState` a real FMCSA-regulated driver can produce
changes, so there is nothing for a version bump to protect, and keeping the version preserves
drift coverage. Both engines were changed in the same commit window, so TS and Dart never
disagree at a given version.

## D-049 — dev's Prisma `connection_limit` set to 4, not tz.md §19's blanket "20" (B-038)
**Problem:** B-038 found `.env.development`'s `DATABASE_URL` at `connection_limit=10` while
tz.md §19 says `Prisma connection_limit=20`, and 324 `P2024`/"too many connections for role
eld_dev" during a k6 run. Naively raising it to 20 would not fix anything: `eld_dev` carries a
hard `ALTER ROLE eld_dev CONNECTION LIMIT 10` (tz.md §22.3.4, also a "Hard rule" in this agent's
own operating contract — "so dev cannot sink prod") that Postgres enforces independently of
whatever number Prisma's own `connection_limit` query-string param says. A Prisma pool
configured for 20 against a role capped at 10 just fails at 10 instead of 20 — same class of
error, sooner.
**Arithmetic.** Postgres `max_connections=100` on the shared dev/prod instance (checked via
`SHOW max_connections;`) — not the binding constraint. The role fence is: `eld_prod`
`CONNECTION LIMIT 40` = `api(20) + worker(20)` exactly (worker is one process, one
`@Global` `PrismaService` singleton shared by all `src/workers/*.processor.ts` — report,
report-scheduler, ifta-nightly, alert, safety-detect, maintenance-due, retention, hos-recalc,
hos-drift, transfer, webhook — not one pool each), so §19's "20" is already correct and
satisfied for prod, unchanged. `eld_dev` `CONNECTION LIMIT 10` is shared by `api-dev`
(always-on, `restart: unless-stopped`) *and* `test:integration`/`test:e2e`
(`test/setup/integration.setup.ts` loads the same `.env.development`), which run concurrently
with `api-dev` and with each other's sibling agents' test suites on this box. The old
`connection_limit=10` in `.env.development` equaled the role cap one-for-one, so `api-dev`
alone could exhaust the entire dev budget with zero spare for a second consumer — exactly
B-038's failure mode.
**Options:** (a) set dev to `connection_limit=20` per the literal tz.md §19 text; (b) raise
`eld_dev`'s `ALTER ROLE ... CONNECTION LIMIT` above 10 to make 20 fit; (c) keep the 10-role-cap
fence and instead shrink the *app-level* pool per consumer so two or more concurrent
consumers fit inside it.
**Choice:** (c) — `connection_limit=4` in `.env.development`/`.env.development.example`/
`.env.example`; `.env.production`/`.env.production.example` untouched at 20.
**Why:** (a) is impossible without (b), and (b) means relaxing a rule stated verbatim in this
agent's Hard Rules ("eld_dev CONNECTION LIMIT 10 (prod 40)") — not this fix's call to make;
raising it would also erode the entire point of the fence, which exists specifically so dev
contention can never threaten `eld_prod`'s budget on the same instance. `connection_limit=4`
means `api-dev` (4) plus one concurrent `test:integration`/`test:e2e` run (4, same env file)
uses 8 of 10, leaving 2 spare for an ad hoc `psql`/`prisma migrate dev` session — verified by
opening two independent 4-connection Prisma pools against `onebook_eld_dev` and fanning 20
concurrent queries across them with no `P2024`. A third simultaneous consumer (e.g. two sibling
agents' test suites running at once, as B-038 observed) can still exceed 10 — that is a real,
accepted limit of a 10-wide shared fence with more than two consumers, not something a bigger
per-process number fixes; documented in `docs/deploy.md` "DB connection pool budget" as an
operational constraint (stagger test runs, or temporarily widen the role limit for a dedicated
load-testing window and revert after) rather than silently baked into a permanently larger
default that would just make P2024s arrive under lighter contention instead of none.
