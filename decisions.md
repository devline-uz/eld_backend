# Decision log

Choices made autonomously while executing `tasks.md`, when the roadmap or `tz.md` left a
question open and waiting for an answer would have stalled the work. Format: the problem, the
options considered, the choice, and why.

Conflict order that governs every entry:
**FMCSA 49 CFR §395 > Pacific Track docs > `tz.md` > Figma > existing code.**

2026-09-14: IDs renumbered to resolve parallel-agent collisions: old→new D-016 (engine-version
mismatch on `POST /mobile/hos-state` is flagged) → **D-074**; D-057 (mock `users` generator,
append-only `AuditLog`) → **D-075**. The earliest-written entries keep D-016 (`seed-shape.spec.ts`
prefix filter) and D-057 (`safety-comms` mock generator). Renumbered entries stay in place. The
next free number is **D-076**.

---

## D-057 — `safety-comms` mock generator: coaching = `SafetyEvent` fields, ticket replies = inline text, notification identity by `type`
**Date:** 2026-09-14 · **Phase:** mock-data pass (`safety-comms.ts` generator)

**Problem.** The brief asks for "coaching sessions… linked to events, with assigned coaches…
statuses and completion notes", "support tickets… with replies", and notifications "coordinated
by type" with the reports agent, but the schema has (1) no `CoachingSession` model — only
`SafetyEvent.status/coachedById/coachedAt/coachingNote`; (2) no `SupportTicket` reply/thread
model; (3) `Notification.type` is a free-text string with no enum or owner column.

**Options.** Coaching: (a) treat `SafetyEvent`'s own coaching fields as the coaching session,
generate nothing else; (b) invent a side table anyway (schema change, forbidden by the brief).
Tickets: (a) leave `body` single-shot; (b) append simulated "--- Support reply ---" blocks into
`body` for non-OPEN tickets; (c) schema change (forbidden). Notifications: (a) pick a `type`
naming convention (`message.new`, `safety.*`) that's provably disjoint from whatever the reports
agent uses for alert-rule notifications, and delete-then-insert scoped to exactly that `type`
list; (b) scope deletes by recipient FK instead (risks catching the reports agent's rows for the
same mock drivers/users).

**Choice.** (a)/(b)/(a) respectively, all without touching `prisma/schema.prisma`.

**Why.** The brief says "never touch schema/migrations… report instead of working around it with
a schema change" — a real reply thread or a coaching-session table would be a schema change no
matter how it's phrased. Encoding replies into `body` and treating `SafetyEvent`'s coaching
fields as the whole "coaching session" both reproduce the intent (a reviewer sees a back-and-forth
/ a completed coaching record) using exactly the columns that exist and that `SafetyController`
already reads/writes. For notifications, `type` is the only column with no other domain's data in
it under `NOTIFICATION_TYPES = ['message.new', 'safety.new_event', 'safety.coaching_assigned',
'safety.coaching_completed']` — grepping the alert/report code shows it never emits those strings
— so scoping cleanup to `type IN (...)` is exact and can never delete the reports agent's rows,
without needing to coordinate on a shared prefix convention.

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

## D-074 — An engine-version mismatch on `POST /mobile/hos-state` is FLAGGED, not rejected
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

## D-048 — `HOS_ENGINE_VERSION` bumped to `1.0.1` for the B-041 gap-resolution fix (REVERSES the original D-048)
**Problem:** B-041 changed how `zonedToUtc()` resolves a local time that does not exist, which
changes RODS day boundaries in midnight-transition zones — a behaviour change to the engine.
Does `HOS_ENGINE_VERSION` bump? The original D-048 (below, superseded) said no, because the
drift checker SKIPS the server-vs-`DriverHosSnapshot` comparison when the versions differ
(tz.md §8), so a bump appears to blind the nightly drift sweep fleet-wide.
**Options:** (a) bump to `1.0.1` on both sides; (b) keep `1.0.0` because no US home terminal
can reach the changed code path; (c) bump and special-case the skip.
**Choice:** (a) — `1.0.1` in `src/modules/hos/hos.constants.ts` and
`mobile/lib/hos/hos_constants.dart`, byte-identical, both pinned by a literal assertion
(`hos.constants.spec.ts` and `mobile/test/hos_engine_version_test.dart`).
**Why:** the original reasoning had the failure mode backwards. An app build already shipped
with the OLD Dart engine keeps reporting `1.0.0` no matter what the server says. With the
server also on `1.0.0`, the nightly sweep and `POST /v1/mobile/hos-state` *do* compare two
engines that genuinely disagree, and any difference is reported as **unexplained drift** —
`alert.hos_engine_drift` + Sentry, with no clue as to the cause. That is the worst of both
worlds: the guard is not preserved, it is poisoned. Bumping makes the same disagreement surface
as `HOS_ENGINE_VERSION_MISMATCH` / `versionMismatch: true`, which names the real cause and
tells the old app its engine is stale instead of silently trusting it. "Never blind the sweep"
is also not free-standing: a version-skipped snapshot is now logged as a WARN by
`HosDriftService.runNightlySweep` (count + `serverVersion`), so the loss of coverage is
visible and bounded by the app-upgrade rollout rather than silent.
**Snapshots already stamped `1.0.0`:** left exactly as they are — accepted-and-skipped, NOT
recomputed and NOT backfilled. `DriverHosSnapshot.hosEngineVersion` records *which engine the
truck ran*; it is evidence, not a server-owned cache, so rewriting it to `1.0.1` would assert
that an old app computed with the new rules. No migration or data backfill is needed: the next
post from each app overwrites the row with its real version, and until then the comparison is
correctly skipped. Nothing in the codebase compares that column for anything other than the
skip decision (`HosStateService.compareSnapshot`); the conformance fixtures in
`eld.docs/hos-conformance/` embed no version string, and `hos-recalc` only stamps
`HOS_ENGINE_VERSION` onto its own result object (never persisted), so there is no latent
equality mismatch left anywhere.

### Superseded — original D-048 (`HOS_ENGINE_VERSION` stays `1.0.0`), kept for history
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

*Status: superseded by the decision above on 2026-09-11 (team-lead call). The factual
claim it rests on — that the changed branch is unreachable for US terminals — still holds; what
it got wrong is that an unchanged version number does not keep old and new engines comparable,
it only hides that they are not.*

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

## D-050 — 2FA/TOTP removed entirely from the backend at explicit user request (2026-09-13)

**Problem:** `tz.md` §6.2 mandates TOTP 2FA for ADMIN and an optional 2FA gate for other back-office
users (`pendingTwoFactorToken` on login, `POST /auth/2fa/verify`, enrolment endpoints,
`TwoFactorSetupGuard` locking a 2FA-less ADMIN to `/me/*`). The user instructed this agent (and the
paired `web/` agent, working in parallel) to remove 2FA completely — no TOTP, no recovery codes, no
`pendingTwoFactorToken` — while keeping the shared contract in sync with the web/mobile clients that
consume `/auth/login` and `/auth/google`.

**Options:**
(a) Leave 2FA in place, against the explicit instruction.
(b) Feature-flag 2FA off but keep the schema/code paths dormant.
(c) Remove 2FA fully: `/auth/login` and `/auth/google` return access+refresh tokens directly, delete
`/auth/2fa/verify`, `/auth/2fa/enroll`, `/auth/2fa/enable`, `TwoFactorSetupGuard`,
`@TwoFactorExempt()`, `User.twoFactorSecret`/`twoFactorEnabled`/`recoveryCodes`, the
`TWO_FACTOR_*` error codes, and the `otplib` dependency.

**Choice:** (c) — full removal, backed by a new Prisma migration dropping the three `User` columns.

**Why:** (a) directly disobeys an explicit, scoped user instruction with no ambiguity to resolve.
(b) leaves dead code, an unused guard in the global chain, and columns that keep showing up in every
`User` snapshot/audit diff — worse for maintainability than removing it outright, and still requires
touching every call site the web agent depends on (`LoginResult` shape) to drop the
`pendingTwoFactorToken` branch, so it doesn't actually save work. (c) is the only option that matches
the shared contract handed to both agents: `POST /auth/login`/`POST /auth/google` always return
tokens directly, the three `/auth/2fa/*` routes are gone, and `twoFactorEnabled`/`twoFactorSetupRequired`
disappear from every response (`/auth/me`, `/me/profile`, `/users`, `/users/:id`, invite). `ERROR_CODES`
is documented as append-only elsewhere in this codebase, but the user's instruction to delete the
`TWO_FACTOR_*` codes is explicit and scoped, so this is a deliberate, recorded exception to that
convention rather than an oversight.

**Follow-up:** `otplib` uninstalled via `npm uninstall` (no other TOTP/2FA library was in use).
`randomOpaqueToken()` (still needed for refresh/reset tokens) moved from the deleted
`lib/totp.util.ts` into `lib/hash.util.ts` rather than kept in a now-misnamed file.

---

## D-051 — Web gaps B-1/B-2: `GET /drivers/roster` and `GET /drivers/:id/hos` read the HOS engine through a batched `HosRecalcService` path (2026-09-14)

**Problem:** the web panel needs HOS clocks per driver on a 25–200 row roster page and for one
driver on four screens. The clocks must be the engine's (shifts and the 30-minute break cross
midnight), must match what `POST /mobile/hos-state` drift-compares against, and the roster route
was being swallowed by `GET /drivers/:id`.

**Options:** (a) read `DriverHosSnapshot` (mobile-reported — stale, absent for drivers without the
app, and it is the thing drift checks, not the truth); (b) call `computeCurrentState` per driver
(2 queries × N rows, dev Prisma pool is 4 — D-049); (c) one batched path: 2 queries for the page,
rows cut in memory to each driver's own home-terminal window, then the same engine input builder.

**Choice:** (c). `HosRecalcService.computeCurrentStates(drivers, now)` shares a single private
`runEngine()` with `recalculate()`/`computeCurrentState()`, so the input is byte-identical (a spec
asserts batch == single-driver state). Nothing is written by either route. `roster` and `:id/hos`
are declared above `:id` in `DriversController`. Permissions: roster = `drivers:READ` (it is the
Drivers screen); `:id/hos` = `hos:READ`, the same key as `GET /logs/*`, because the card is HOS data
shown on Logs, Messages and Trips too. Response shapes are exactly the web types
(`DriverRosterResponse`, `DriverHosResponse`); `/hos` adds `dutyStatus`, `statusSince`,
`computedAt` (additive). `breakInSec` = engine `breakRemainingSec` (driving seconds until the break
is due; stays at 8 h for passenger/short-haul, where the break does not apply), `breakLimitSec` =
8 h, `onDutySince` = start of the running 14-hour window. Duty status maps D/ON/SB/OFF to
DRIVING/ON_DUTY/SLEEPER/OFF_DUTY from the engine's effective status (PC shows OFF_DUTY, YM shows
ON_DUTY). Roster default sort is `lastName:asc`; B-55 filters `terminal` (exact, case-insensitive),
`hasOpenViolation`, `exempt` (`eldExempt`) run in SQL so pagination stays correct. A `dutyStatus`
filter is NOT offered: it is computed, and filtering after paging would lie about `total`.


## D-052 — Web gap B-6: `GET /violations` defaults to OPEN, resolve is a violation-row-only status change, no `POST /violations` (2026-09-14)

**Problem:** W-01 (`window=24h`) and W-08 `Resolve` need a fleet violation list and a manual resolve;
`HosViolation` rows only rode inside `GET /logs/:driverId`. tz.md §11.4 lists `GET/POST /violations`.
(D-051 was already taken by the parallel B-1/B-2 roster decision, hence D-052.)

**Options:** (a) list every status by default vs (b) default `status=OPEN`; (c) implement `POST
/violations` (manual create) vs (d) omit it; (e) resolve by editing RODS records vs (f) resolve as a
status change on the `HosViolation` row only.

**Choice:** (b) + (d) + (f). `GET /violations` (`hos READ`) defaults to `OPEN` (`status=ALL` widens it);
`from`/`to` win over `window`. `POST /violations/:id/resolve` (`hosEdit FULL`, per web/tz.md RBAC table)
takes a 4-60 char `resolutionNote`, uses a conditional `updateMany where status=OPEN` (race-safe, 409
otherwise), and writes `VIOLATION_RESOLVED` to AuditLog as part of the operation (not best-effort). Unit
and location are display joins from the active EldEvent at/before `occurredAt`, falling back to the
driver's assigned vehicle. No schema change: `resolvedAt/resolvedById/resolutionNote` and `RESOLVED`
already existed.

**Why:** the W-01 KPI is defined as open violations (web/tz.md W-01 KPI 3). Violations are derived by the
HOS engine (TZ §8.4); a manual create would put a non-engine record beside §395 data with no rule behind
it. Under §395.8/§395.30 the RODS records are the evidence and only the edit flow may change them, so
resolving must never touch EldEvent/DailyLog; recalc already keeps a RESOLVED row (hos-violation-plan rule 3).

## D-053 — Web gap B-3: `GET /live/fleet` snapshot semantics (2026-09-14)
**Problem:** W-01/W-02 need one call returning every unit's last position, driver, duty status, HOS clocks and ELD link in the exact `web/src/shared/api/liveFleet.ts#LiveFleetUnit` shape. The backend has no per-unit "current status" column, the web `DutyStatus`/`bleState` unions differ from ours (`IDLE`, `ELD_OFFLINE`, `INACTIVE`; no `OUT_OF_RANGE`), tz.md §19 asks for a 10 s cache but the API has no Redis cache client, and a fresh DB has no telemetry so the map is empty.
**Options:** (a) run `computeCurrentState` per driver (N+1, ~900 queries per poll at 300 units); (b) read the app-submitted `DriverHosSnapshot` (0 rows in dev, and an app claim, not the server's figures); (c) batch: 4 constant queries (vehicles+device+driver, LATERAL latest `TelemetryPoint`, LATERAL latest located `EldEvent`, latest status/PC-YM record per driver) plus the batched `HosRecalcService.computeCurrentStates` (D-051).
**Choice:** (c), in `src/modules/live/`, `@Perm('liveFleet','READ')`, single-tenant scope (§27.3). Rules, all in the pure `live-fleet.mapper.ts`:
- position = newer of the latest telemetry fix and the latest located RODS record (both already coarsened at ingest); `locationLabel` only when that record is the fix or within 30 min of it; rows dated more than 10 min in the future (§7.3 rule 5) are ignored.
- `speedMph` is null when the fix is older than 30 min; `odometerMi` falls back to `Vehicle.odometerMi`.
- `bleState`: `CONNECTED` only when the row says so AND the heartbeat is within 30 min; `OUT_OF_RANGE`/stale is `DISCONNECTED`; no device is `null`.
- `dutyStatus`: with an assigned driver, the server HOS status (D/ON/SB/OFF), `PERSONAL_CONVEYANCE`/`YARD_MOVE` when an active eventType-3 indication is not older than the last status record and fits the status, `IDLE` = ON + fresh fix + engine on + 0 mph. Without a driver: `ELD_OFFLINE` if the device is unseen > 30 min (same line as `alert.eld_disconnected`), `OFF_DUTY` if an ELD is alive on an active unit, otherwise `INACTIVE`.
- a driven unit with a dead ELD keeps its HOS status (compliance data wins); the link shows in `bleState`.
- 10 s in-process memo, sharing in-flight promises; failures are never cached; an HOS engine error drops the clocks, not the map.
- the seed writes one coarse position per device-equipped unit ONLY when that unit has no telemetry at all, so it is idempotent on any day and never shadows ingested data.
**Why:** (a) breaks the §19 no-N+1 rule, and (b) shows the app's own figures instead of the server's. (c) keeps the query count constant at any fleet size and reuses the one engine path the roster uses, so the Live Fleet and roster clocks can never disagree. The in-process cache is per API container, which is acceptable for a 10 s TTL. Swap to Redis if a shared cache client is introduced.

## D-054 — Web gap B-46: `GET /reports/ifta/summary` — JSON read of the same IftaSegment/FuelPurchase totals as the CSV, `null` instead of invented numbers (2026-09-14)

**Problem:** W-12 renders `Jurisdiction totals are not available` because no JSON endpoint exposes the
per-jurisdiction IFTA totals the queued CSV (`IftaReportGenerator.rows()`) already computes from
`IftaSegment`/`FuelPurchase`. §15 still forbids generating a `Report` row inside a request, but this is a
direct read, not a report job, so it can answer synchronously.

**Options:** (a) queue an `IFTA` report and have the client poll/parse the CSV for the KPI row (defeats
the point of a summary screen); (b) re-derive totals with a separate, looser formula for the JSON route
(risks disagreeing with the CSV number a driver later files); (c) add a synchronous
`IftaReportGenerator.summary()` built from the exact same `iftaSegment.groupBy`/`fuelPurchase.groupBy`
aggregates `rows()` uses, plus one extra query each for `unitCount` (distinct `vehicleId` with a segment
in-quarter) and `receiptCount` (`FuelPurchase.count`), plus a second, identical aggregate for the prior
quarter to derive `fleetMpgPrev`.

**Choice:** (c). `GET /reports/ifta/summary?quarter=YYYY-Qn&vehicleId?`, `@Perm('reports','READ')`,
declared in `reports.controller.ts` before `GET /reports/:id` (a 2-segment path can't collide with the
1-segment `:id` route either way, but ordering documents the intent per the brief). Response body IS
the summary object directly — **no `{ data: ... }` envelope** — matching what the web side had already
implemented and committed against (`web/src/shared/api/reports.ts#IftaSummary`, `client.get<IftaSummary>`
with no unwrap) by the time this endpoint landed; the brief that kicked this task off said `{ data: {...} }`
but the live web contract wins per this task's own "keep the shape exactly as documented [by web]"
instruction — flagged here as the one deviation from that brief:
```
{ quarter, unitCount,
  kpis: { totalMiles, taxableMiles, taxablePct: number|null, fuelGal: number|null,
          receiptCount: number|null, fleetMpg: number|null, fleetMpgPrev: number|null },
  rows: [{ jurisdiction, totalMiles, taxableMiles, fuelGal: number|null, mpg: number|null, taxDueUsd: null }],
  totals: { totalMiles, taxableMiles, fuelGal: number|null, mpg: number|null, taxDueUsd: null } }
```
(`totals` — one row without `jurisdiction` — and every nullable field matches
`web/src/shared/api/reports.ts` (`IftaKpis`/`IftaJurisdictionTotals`) and `web/decisions.md` WD-068
exactly, confirmed by reading that file rather than only the backend-gaps.md table cell.) No
`TaxRate`/per-jurisdiction rate model exists anywhere in the schema, so `taxDueUsd` is always `null`
(rows and totals) — never estimated. `taxableMiles` = `totalMiles`: no trip-permit/exemption model
exists to subtract from it, so every recorded mile is taxable in this version. `taxablePct` is `null`
(not `0`) when `totalMiles` is 0 — nothing to compute a percentage of. `fuelGal`/`receiptCount` (kpis and
rows/totals) and `fleetMpg`/`mpg`/`fleetMpgPrev` are `null` — not `0` — for a whole quarter whenever that
quarter's `FuelPurchase.count` is 0 for this carrier (a single "has fuel data at all" flag per quarter);
a jurisdiction that legitimately purchased 0 gallons while others in the same quarter purchased some
still reports a real `0` for that row. Dev DB currently has 0 rows in both `IftaSegment` and
`FuelPurchase`, so every quarter today answers `unitCount: 0`, empty `rows`, `taxablePct/fuelGal/
receiptCount/fleetMpg(Prev)` all `null` rather than an error — the nightly `ifta-nightly.processor` has
simply never run against this seed.

**Why:** reusing the identical Prisma aggregates the CSV export already trusts is the only way the JSON
KPI row and the CSV a driver files can never quote different numbers for the same quarter — a mismatch
here is worse than showing `—`. `null`-vs-`0` is deliberate throughout: a `0` MPG or `$0` tax due reads
as a real, audited figure to a fleet manager; `null` renders `—` on the web side and can't be mistaken
for one. Matching the live web contract (no envelope, nullable KPI fields) rather than the brief's
literal wrapper avoids breaking the parallel W-12 wiring that was built against the actual committed
web types.

## D-055 — Mock-data framework (`prisma/mock/`) and core-fleet generator (2026-09-14)

**Problem:** eight agents need a shared, idempotent way to layer ~6 months of realistic mock
data (200 drivers) onto the dev DB, on top of (never touching) `prisma/seed.ts`'s Universal
Logistics demo rows, without exceeding a ~1.5 GB disk budget or ever writing a future timestamp.

**Options considered:**
1. One big script all agents co-edit — rejected: constant merge conflicts, no way to run a
   single domain in isolation, one bug wipes everyone's data.
2. Per-domain Prisma seed files run independently with no shared contract — rejected: no common
   PRNG (non-reproducible), no common "mock identity" (can't safely re-run one domain without
   risking deleting another's or the real seed's rows), no ordering guarantee.
3. `prisma/mock/{context.ts,index.ts,generators/*.ts}` with a fixed `MockContext`
   (`prisma, rng, carrierId, from, to, log`), a fixed generator signature
   (`run(ctx) => Promise<Record<string, number>>`), a fixed run order enforced by the
   orchestrator, and a documented mock-identity convention — **chosen**.

**Why:** the shared `MockContext` gives every generator the same seeded PRNG (reproducible runs,
reviewable diffs) and the same 6-month window derived from the live `Carrier.timezone` (so it is
never stale and never in the future — ties directly into B-044). The fixed order
(`core -> users -> hos -> ingest -> compliance -> fleet -> safety-comms -> reports`) is what every
generator must be run in relative to the others; `index.ts` checks it against DB state, not the
CLI argument list (see the id-stability fix below). Returning row counts from `run()` gives one
uniform place to print sizing for the disk budget instead of eight different ad-hoc logs.

**Fix (2026-09-14, same day, reported by the coordinator once the other 7 generators were
already writing FKs against `core`'s rows):** the original guard required `core` to be present
on the same CLI invocation as any other generator (`npm run db:mock -- ingest` was rejected;
only `npm run db:mock -- core ingest` passed), and `core` itself deleted and recreated every
Driver/Vehicle/Device row on every run with fresh random ids. Combined, this meant the *only*
way to run a single downstream generator re-ran `core` first and silently changed every id
`EldEvent`/DVIR/telemetry/etc. from earlier generator runs pointed at — an unrecoverable
append-only-table foreign-key break. Two changes:
1. `index.ts`'s guard now queries the DB directly (`assertCoreExists`: counts of `mock_*`
   drivers / `M1...` vehicles / `MOCKPT30-*` devices) instead of inspecting `process.argv`. A
   lone `npm run db:mock -- ingest` is allowed exactly when those rows already exist, and errors
   with a specific message otherwise.
2. `core.ts` now UPSERTS Driver/Vehicle/Trailer/Device by natural unique key
   (`username`/`unitNumber`/`number`/`serial`) instead of delete-then-`createMany`. A row that
   already exists (even with a pre-existing random id, e.g. every row created before this fix)
   keeps its id forever — the `update` branch never writes `id`. A brand-new row gets
   `mockId(domain, naturalKey)`, a deterministic UUID v5 (hand-rolled in `context.ts` off
   `crypto.createHash('sha1')`, RFC 4122 — not the `uuid` package, which is not a declared
   dependency), so future re-runs are stable from the very first run onward too.
   `Driver.assignedVehicleId` and `Device.vehicleId` are both `@unique`, so before reassigning
   them `core.ts` first bulk-clears every mock row's value to `null` (Postgres allows unlimited
   `NULL`s on a unique column) — otherwise two concurrent per-row upserts can transiently collide
   when this run's desired assignment differs from a stale one already on disk.
   `CoDriverPairing` is the one exception left as delete-then-`createMany`: nothing else in the
   schema holds a FK to a pairing's id (it is a leaf table) and it has no natural unique column
   to upsert against, so full replacement is simplest and equally safe.
   **Verified:** ran `npm run db:mock -- core` twice and diffed the full `(natural key, id)` set
   for all 200 drivers / 170 vehicles / 140 trailers / 164 devices — byte-identical both times.

**Mock identity extended beyond the brief's Driver/Vehicle/User list:** `Trailer` and `Device`
(when unpaired) have no FK back to a mock driver/vehicle and no free-text field to carry the
`[mock]` marker literal. Extended the same "unique-column prefix" pattern already used for
`Vehicle.unitNumber` (`M1...`) to `Trailer.number` (`MOCKTRL-...`) and `Device.serial`
(`MOCKPT30-...`) — both are unique, human-legible, and let every generator's cleanup step run a
plain `startsWith` query with no join, exactly like the Driver/Vehicle convention it mirrors.

**Assignment count deviation:** the brief's illustrative "~15 drivers unassigned" is not reachable
together with "~170 vehicles" and 200 drivers, because `Driver.assignedVehicleId` is a genuine
1:1 (`@unique`) — at most one driver per vehicle, ever. With ~170 vehicles (150 ACTIVE, the only
ones assigned) and 200 drivers, the ceiling is ~150 assigned / ~50 unassigned regardless of RNG
tuning. Chose to keep the vehicle count at the brief's explicit ~170 and let the unassigned count
float to what the schema allows (51 in the run recorded below) rather than inflate the fleet size
to force a smaller unassigned number — vehicle count is the more specific, explicit deliverable.

**Driver "hire date":** `Driver` has no dedicated hire-date column (§5.3). Used `registeredAt` as
the hire-date proxy the brief asks for ("hire dates both before and inside the window"): ~70% of
mock drivers get a `registeredAt` from 6-96 months before the mock window starts (veteran
drivers), ~30% get one inside the window (new hires).

**Verified `npm run db:mock -- core` run (2026-09-14, run twice for idempotency, identical
counts both times):** 200 drivers (51 unassigned, 10 co-driver pairings), 170 vehicles, 140
trailers, 164 devices (146 paired + 12 spare + 6 retired). Table sizes after the run: Driver
472 kB, Device 320 kB, Vehicle 272 kB, Trailer 152 kB, CoDriverPairing 80 kB —
`onebook_eld_dev` total 21 MB, far inside the 1.5 GB budget. Pre-existing seed rows (77
non-mock vehicles, 64 non-mock drivers, the John Smith/Marcus Webb pairing, 20 non-mock
devices) were unaffected by either run.

## D-056 — Mock `ingest` generator: telemetry cadence, append-only eventType 7, device/DTC representation (2026-09-14)

**Problem.** `prisma/mock/generators/ingest.ts` must add 6 months of telemetry, BLE/device state,
malfunctions/diagnostics, DTCs and odometer data for 170 mock vehicles inside a 450 MB share,
idempotently, on top of the `hos` generator's EldEvents — but `EldEvent` is append-only
(UPDATE/DELETE revoked, B-009), and several requested concepts have no table.

**Options / choices.**
- *Telemetry cadence:* 1 fix/60 s (the app's real rate) would be ~10 M rows (> 2 GB). Chose one fix
  every 5 min while driving for the last 14 days and every 60 min before (the coordinator cut the telemetry budget to <= 250 MB after free disk dropped to 2.2 GB). A first run at 30 min produced 803 k rows / 370 MB — real rows cost ~480 B with both indexes, not the ~230 B estimated — so it was deleted, the partitions compacted with VACUUM FULL, and the cadence thinned: older than 14 days a segment keeps only its hourly route ticks and the stop fix (no pre-trip idle, rest-window idle or engine-off fix). Every insert batch first checks free space on / and stops below 1.2 GB, keeping committed batches, plus a pre-trip idle fix,
  a stop fix at every segment end, idle fixes (engine on, 0 mph) when the next status is ON, and an
  engine-off fix otherwise. Positions are interpolated along a bowed chord between the recorded
  event locations and coarsened to 1 mile before insert (no raw fix exists anywhere); odometer is
  interpolated between event `totalVehicleMiles`, so speed = recorded distance / time. PC/YM
  movement gets no telemetry (it would need 10-mile coarsening and is a small share).
- *Live state:* an open D segment is extended from its last waypoint to `now` on its last heading
  (<= 90 min), so the Live Fleet shows it moving; ON right after driving gets a 5-min idle tail;
  OFF/SB end with an engine-off fix. 4 currently-driving units are cut 40-150 min early with a
  DISCONNECTED/OUT_OF_RANGE device and a `storedEventsCount` > 100 backlog ("stale"). Driverless
  vehicles keep their last fix and a DISCONNECTED device (ELD_OFFLINE on the map).
- *eventType 7 idempotency:* delete-then-insert is impossible on `EldEvent`. Chose deterministic
  `mock-md-*` uuids, inserted only when no such row exists for mock vehicles, with
  `skipDuplicates`. Sequence IDs continue each driver's `EventSequenceCounter` (same key and wrap
  as `IngestRepository.allocateSequenceIds`). Re-runs therefore leave the first run's records.
- *Not representable (no model):* BLE/heartbeat *history* (Device holds only the current state),
  firmware update history, odometer calibration history (only `Vehicle.odometerCalibratedAt`),
  and `GET /devices/:id/diagnostics` (web gap B-8). DTC severity has no column, so it prefixes
  `description` ("Critical: …", "Warning: …", "Info: …"). Device firmware stays as `core` set it.

**Why.** Keeps every stored value consistent with the RODS records the HOS engine reads, stays far
inside the disk budget, and never writes UPDATE/DELETE against the append-only table.

---

## D-075 — Mock `users` generator: append-only `AuditLog`, per-user custom permissions, and role identity (2026-09-14)

**Problem.** `users.ts` owns panel users, custom roles, sessions, API keys and the audit log
(tz.md §6/§18). Three things in the brief don't map cleanly onto the schema: (1) idempotent
re-runs normally delete-then-recreate a generator's own rows, but `AuditLog` is append-only at the
DB level (`REVOKE UPDATE, DELETE`, same pattern as `EldEvent`/B-009) — `deleteMany` throws
`permission denied for table AuditLog` (B-045); (2) "a few users with custom permission
overrides" — the schema has no per-user override, only `Role.permissions`; (3) finding "this
generator's own custom roles" on re-run needs a stable identity distinct from the 4 system roles.

**Options / choices.**
- *AuditLog idempotency:* never delete. Each of the 4 000 mock rows gets a deterministic id
  (`9_000_000_000n + planIndex`) and inserts go through `createMany({ skipDuplicates: true })`, so
  a re-run is a true no-op for that table (0 inserted, table stays at 4 000) instead of erroring or
  duplicating. Tradeoff accepted: a mock audit row's `actorId`/`objectId` can outlive the mock
  User/Role/ApiKey it named, once *those* tables get deleted-and-recreated on a later `users`
  re-run (their ids are fresh UUIDs each time) — acceptable for exercising cursor pagination and
  `GET /audit-log`, never acceptable for a real compliance trail.
- *Per-user permission overrides:* not representable as asked, so approximated with distinct
  one-off custom `Role`s instead (`MOCK_ROLE_DISPATCH_READONLY`, `MOCK_ROLE_FLEET_OPS_LITE`,
  `MOCK_ROLE_VIEWER_PLUS_MESSAGING`), each a documented single-field diff from its closest system
  role, assigned to exactly one mock user apiece — same practical effect (a user whose effective
  permissions differ from every system role) without a schema change.
- *Custom-role identity:* `Role.key` prefixed `MOCK_ROLE_` (`MOCK_ROLE_PREFIX` in `users.ts`) —
  distinct from the 4 system keys (`ADMIN`, `FLEET_MANAGER`, …) and from any real carrier-defined
  role a human might add later, so cleanup never touches anything but this generator's own rows.

**Why.** Honors the "never delete/UPDATE `AuditLog`" DB-level guarantee exactly (no workaround, no
disabling the guard, per the coordinator's explicit instruction), keeps custom-permission coverage
in spirit given the actual schema, and keeps idempotent re-runs safe without inventing new FKs.

## D-070 — Mock `compliance` generator: append-only idempotency, building on `hos` instead of duplicating it (2026-09-14)
**Problem:** the compliance mock data (§395.30 edit requests, unidentified driving, re-certification, eRODS transfers) is almost entirely APPENDED `EldEvent`/`AuditLog` records, and both tables have UPDATE/DELETE revoked for `eld_dev`, so the framework's "delete my rows, then insert" rule cannot apply. The `hos` generator (landed in parallel) already writes certifications (eventType 4), §9.3 self-edits and unidentified pool records, so a naive compliance pass would double-certify days and invent a second set of unidentified driving.
**Options:** (a) temporarily GRANT DELETE to the owner role and purge (what `hos` does for its own rows, D-069 per its header); (b) TRUNCATE/partition detach — destroys non-mock rows, rejected; (c) deterministic record identity + skip-existing, never touching the guard.
**Choice:** (c). Every appended record's uuid is a v5-shaped hash of what it represents (e.g. `edit:<target uuid>:req`, `<segment id>:asg:cp:<i>`, `cert:<driver>:<date>:<index>`) with the fixed tail `c0c0c0`; a re-run looks the uuids up and inserts only the missing ones. Plans are computed from the base timeline only (records NOT ending in `c0c0c0`), with per-entity seeded RNGs and a fixed horizon (2026-03-14 + 184 d), so run order and wall clock do not change the plan. Audit rows are matched by (action, objectId, occurrence) among `[mock]`-prefixed details. Mutable rows owned here are rebuilt: `UnidentifiedSegment` with `[mock]` in `startLocation`, mock drivers' `DataTransfer`s plus `mock/transfers/` objects in MinIO, and the certification columns of the `DailyLog`s this generator touched (recomputed from the base eventType 4 records + its own changes). Scope split with `hos`: `hos` owns base certification and §9.3 self-edits; `compliance` owns carrier edits, all `UnidentifiedSegment`s (built from `hos` pool records + short yard moves + "moved before logging in" episodes), re-certification of the days those change, and transfers. Transitions go through the production planners/rules (`planEditRequest`/`planAcceptEdit`/`planRejectEdit`, `checkEditProposal`), `IngestRepository.allocateSequenceIds`, `computeChecksum`, and the Appendix A builder + validator; before allocating, the per-key counter is moved past the highest `eventSequenceId` on the table, because `hos` resets counters to its own maximum when it re-runs.
**Why:** it keeps the append-only guard intact (§5.5, §23), is safe to run repeatedly, and never manufactures a record the real API would refuse. **Known limit:** if `hos` re-creates its events, the compliance records that point at the old ids (supersedesId, segment eventIds) are orphaned and cannot be removed by this generator; `hos`'s cleanup should also purge `uuid LIKE '%c0c0c0'` for mock drivers/vehicles, and `compliance` must re-run after `hos`.

## D-071 — Mock `hos` generator: idempotent 6-month duty history without ever deleting an `EldEvent` (2026-09-14)
**Problem:** the framework rule "delete your own rows, then insert" cannot apply to `EldEvent` (UPDATE/DELETE revoked, §5.5/§23), and the coordinator forbade disabling the guard. A first draft granted the owner role DELETE inside one transaction (the "D-069 per its header" that D-070 quotes); it was never run and was removed. The plan also depends on wall-clock `now` (the live tail of every driver), so deterministic uuids + `skipDuplicates` alone would append a second, shifted timeline on a later run.
**Options:** (a) transient self-GRANT DELETE — rejected (disables the guard); (b) deterministic uuids + skip-duplicates — insufficient, `now` moves; (c) generate once atomically, then only rebuild what is derived from the stored records.
**Choice:** (c). Every record `hos` writes has a uuid starting `6d6f636b-` ("mock", v4-shaped). If any exist for mock drivers/vehicles the run is REFRESH: events untouched; `DailyLog` headers upserted from the stored records with the production `buildRodsDay`; violations re-derived by the production `HosRecalcService` (upserts, RESOLVED/AUTO_CLEARED preserved by `reconcileViolations`); snapshots and `EventSequenceCounter` (GREATEST, never lowered) refreshed. Otherwise GENERATE: all ELD records + headers in one transaction, then recalc pass 1 (one call per RODS day with `now` = end of that day, as production accrues), then the §9.3 self-edit records, then recalc pass 2 over the edited days (this is what produces AUTO_CLEARED rows), then a share of older OPEN rows resolved.
**Why:** the guard stays intact, a re-run is safe at any time, and no violation is hand-made. Per-day recalc is required, not a speed choice: `computeHos` keeps only the latest 34 h restart (`resolveRestartEnd`) and skips cycle checks for days before it, so one recalc over 6 months would silently drop most historical CYCLE violations. **Known limit:** a crash between the stage-1 commit and the edit records leaves a consistent dataset without the AUTO_CLEARED story (REFRESH will not add it); `hos` never re-creates events, so D-070's orphaning concern does not arise unless core ids change.

## D-072 — `reports` mock generator: `Notification.type` mirrors `AlertRule.id` (the real `AlertProcessor` behaviour), not a human-readable key (2026-09-14)
**Problem:** mock `Notification` rows created for the 10 mock `AlertRule`s (`mock_hos_violation`,
`mock_speeding`, …) have `type` set to the owning `AlertRule.id` (a uuid, e.g.
`82eff70e-20f8-4f4b-ba1e-d95b72de2781`) rather than a semantic string like `hos_violation`. A
mid-task review flagged this as a bug, citing the `NotificationsController` swagger example
(`type: 'hos_violation'`) and worrying it would break the panel's icon/type rendering.
**Options:** (a) change the generator to write a human key (e.g. `def.key` minus the `mock_`
prefix) into `Notification.type`; (b) keep `type = alertRuleId`, matching the real write path.
**Investigation:** the real, only in-app-notification writer for `AlertRule`-triggered
notifications is `AlertProcessor.send()` (`src/workers/alert.processor.ts`), which does
`data: { ..., type: rule.id, title: ..., body: ... }` — literally the rule's uuid, not its `key`.
`NotificationsService.list()` / `NotificationsRepository.list()` (`src/modules/notifications/`)
return `type` completely unmodified — there is no join back to `AlertRule.key` anywhere in the
read path. The swagger `type: 'hos_violation'` in `NotificationsController` is a doc-only
example, not a contract the running code honours; `title`/`body` (which the real processor also
populates from `payload.title` / a JSON dump, and which this generator populates with
`rule.def.name`, e.g. "HOS violation [mock]") are what actually carries the human-readable text
for the bell UI.
**Choice:** (b) — kept `type = rule.id`, exactly matching `AlertProcessor`'s real behaviour, cited
above by file/line. Mock data's job is to reproduce what the real system actually writes, not
what a stale doc comment says it should write; deviating here would make the mock inconsistent
with what a real alert delivery produces today, undermining the "test against realistic data"
purpose of this whole exercise.
**If `AlertProcessor` is actually wrong** (i.e. it should have written `rule.key` all along) —
plausible, and worth someone owning `src/workers/alert.processor.ts` looking at — that is an
application bug independent of mock data and out of this generator's scope (`prisma/mock/` may
not change application source). Flagging here rather than silently "fixing" the mock to disagree
with production code.
**Addendum (same day, after validation runs):** run 2 was NOT idempotent: 283 events and 214 audits were added, because the candidate filter `eventDateTime <= now - 6h` grew with the wall clock and reshuffled the per-driver picks. Fixed with `CANDIDATE_CUTOFF = 2026-09-14T06:00Z`. Run 3 re-aligned the data (195 events added). Run 4 added nothing: 0 events and 0 audits inserted, 6,862 skipped. Runs 2 and 3 left orphan append-only rows that cannot be removed: 536 edit requests exist against about 391 in the plan, and 2 driver-days carry two accepted edits. Those orphan edits are not reflected in the `DailyLog` re-certification replay.

## D-073 — B-055: bounding the batched HOS read without changing a single clock (2026-09-14)
**Problem:** `computeCurrentStates` (the roster and `/live/fleet`) used ~700 MB RSS and took 10–16 s. The brief asked for per-driver windows bounded by the last 34 h restart, a row cap that never silently truncates, and results identical to the old code.
**Options:**
1. One query per driver: simple, but 200+ round-trips per request on a 10-connection role.
2. Group drivers by distinct `from` and use `IN (...)`: still full rows, and the saving is only a few hours.
3. One `unnest` + `CROSS JOIN LATERAL` statement with a per-driver `from` and `LIMIT`, slim columns, `eventType IN (1,3)`, and drivers processed in chunks.
4. Also trim each window at the driver's last 34 h restart.
**Choice:** option 3, without option 4. The cap is `HOS_BATCH_MAX_EVENTS_PER_DRIVER = 2000`; the query fetches cap + 1 rows so the service can tell a full window from a truncated one. A driver over the cap is logged and omitted, never computed. Chunks hold 25 drivers.
**Why:**
- The measured cost was materialising full rows, not the window width.
- Filtering to types 1/3 and selecting the mapper's columns is provably input-preserving: `mapEldEventsToNormalized` drops every other type, and the order is total on (eventDateTime, eventSequenceId) per driver.
- Restart trimming was rejected. The service passes `lastRestartEndedAt: null`, no restart is stored, and `HosState.violations` includes pre-restart days inside the window. Trimming would change results, which the brief forbids. The 9-day window is already the cycle plus carry-in.
- Omitting an over-cap driver fails loudly and per driver, instead of producing wrong clocks or failing the whole fleet page.

## D-076 — B-059: where the `DailyLog` header is rebuilt, and how a day is counted (2026-09-14)
**Problem:** `DailyLog` totals were written only by the `GET /logs` read path, so every writer of §395 records left them stale. `hos.recalc` reads those totals as the 70/8 recap (`previousDays`), so stale totals reach the engine. Each writer needed a rebuild without a circular Nest dependency (`LogsModule` imports `IngestModule`, so ingest cannot call `LogsService`) and without a second, drifting copy of the counting rules.
**Options:**
1. Rebuild only inside each writing service: edit accept, self-edit, unidentified assign/reject, ingest. Ingest cannot reach `LogsService`, and a status carried for days could need an unbounded forward rebuild on the request path.
2. Rebuild only inside `hos.recalc`. Every writer already enqueues it, but a failed enqueue or a slow worker leaves the header visibly stale after an edit.
3. Both, through one pure builder. The writers rebuild synchronously (touched days + the next day, best effort). `hos.recalc` rebuilds `[fromDate − 1, today]` before it reads the recap.
**Choice:** option 3. `src/modules/logs/daily-log-header.ts` (`buildDailyLogHeaders`, `affectedHeaderRange`) is the only header derivation. `LogsService.buildDays`, `LogsService.rebuildDailyLogsForSpan` (edit accept, self-edit, mobile sync, unidentified assign/reject) and `HosRecalcService.rebuildDailyLogs` (the job, the ingest path, the mock generators, repairs) all call it.
**Details that were choices, not givens:**
- **Lookback 9 days everywhere.** The log view used 2, so an SB/ON status carried for 3+ days read as off-duty on the grid while the engine (9 days) counted it. Both paths now use `RODS_HEADER_LOOKBACK_DAYS = 9 = RECALC_LOOKBACK_DAYS`, so they cannot overwrite each other with different numbers.
- **`fromDate − 1`.** A header written while its day was still running (a `GET /logs` at noon) stayed partial forever. That was 62 seed-driver rows on 2026-09-13. The day before the recalculated range is exactly the recap day most likely to be affected. A change at instant t never alters anything before t, so no earlier day is needed.
- **Whole-second grid in `buildRodsDay`.** Each duration is `round(end) − round(start)`, not `round(end − start)`. Millisecond-stamped ingest records made finished days total 86 370–86 401 s. On the grid the durations telescope to exactly `dayLengthSec` (86 400, or 23 h / 25 h on DST days). The HOS engine's own clocks are untouched (no `HOS_ENGINE_VERSION` change). Only the RODS grid/header counting changed.
- **Contiguous grid in `buildRodsDay`, not an engine change.** The engine's `buildSegments` drops a segment that rounds to 0 s, which left holes of up to 0.5 s per record in the RODS grid (31 s on one ingest-heavy day). The hole is closed on the RODS side by running each segment to the next one's start, following the engine's own "the later record at an instant wins". Changing `hos/engine/normalize.ts` would alter engine clocks and force a `HOS_ENGINE_VERSION` bump plus a Dart mirror change for a sub-second effect, so it was not done.
- **Writers never fail on a rebuild error.** The records are committed and `hos.recalc` rebuilds the same headers, so `rebuildDailyLogsForSpan` logs and returns 0.
- **Certification is never written by a rebuild.** `hasEdits` stays sticky (once true, never cleared). B-050 (assignment not voiding certification) stays out of scope.
- **Repair recalc window:** each stale day plus the 8 following days, one call per RODS day (D-071), because a corrected total changes the recap of the next 7 days.
**Why:** one counting function removes the class of bug, not just the 1,270 instances. The recalc-side rebuild is the backstop that also covers ingest, which has no path to `LogsService`.

---

## D-077 — B-061: repairing `AuditLog` rows orphaned by the pre-id-stability `users` mock generator (2026-09-14)

**Problem.** Every earlier run of `prisma/mock/generators/users.ts` deleted and recreated its
`User`/`Role`/`Session`/`ApiKey` rows with fresh random ids. `AuditLog` (append-only, B-045)
had already named 60 `actorId`s and (found on closer audit) 54+410+557 `objectId`s belonging to
`User`/`Role`/`ApiKey` rows from a run that no longer existed. Those `AuditLog` rows can never be
UPDATEd or DELETEd — the DB role has no grant for either — so the only lever is what the
referenced id resolves to, not the `AuditLog` row itself.

**Options considered for the stale ids already written:**
(a) *Recreate the original rows on their original ids*, recovered by mapping old id → natural key
(email/key) from the audit rows' own `before`/`after` payloads or prior run logs. **Rejected**:
this generator's payloads (`auditPayloadFor`) were written before this defect was known and never
carried the actor's email — e.g. `LOGIN` -> `{detail: 'password login'}` with no identifying
field — and no separate log of "old id -> email" was ever kept. The mapping is genuinely gone;
inventing one (e.g. arbitrarily reassigning old ids to today's 40 users) would silently rewrite
audit history no reviewer could tell apart from the "repaired" case.
(b) *Placeholder rows on the exact stale id.* **Chosen.** A minimal, clearly-marked row — DISABLED
`User` (`deleted-<id8>@mock.onebook.example`, name "Deleted mock user"), all-`NONE` placeholder
`Role`, pre-revoked placeholder `ApiKey` — created directly on the id `AuditLog` already has, so
every lookup resolves. The UI shows an honestly-labelled "deleted" actor/object instead of a
broken reference or a fabricated real one.

**Going forward:** the actual fix is id stability, not the repair — `mockId(domain, naturalKey)` +
`upsert` (never delete+recreate) for every table this generator owns, so this repair step is a
no-op after the one time it runs against currently-orphaned data (self-verified: 0 repairs on the
second and third re-run).

**Why.** Honors "never add UPDATE/DELETE on AuditLog" exactly as instructed, never fabricates
history, and is self-healing rather than a one-off manual SQL patch — any *future* class of
id-instability bug (in this generator or another) gets the same automatic repair for free.

## D-078 — B-46 activity half: `GET /reports/activity/summary` aggregates `DailyLog` in SQL, never per-driver `LogsService.getRange` (2026-09-14)
**Problem:** the web fanned out one `GET /logs/:driverId/range` call per driver for W-13 Activity, W-15 FMCSA pack and the dashboard — 308 calls in one QA session, 3s→15s. A JSON aggregate endpoint was needed that returns per-driver totals plus fleet KPIs with period-over-period deltas, bounded in both time and memory (B-055's OOM is the standing warning here).
**Options:**
1. Reuse `LogsService.getRange`/`buildDays` per driver (what `ActivityReportGenerator`, the CSV export, already does) — rejected: this IS the per-driver fan-out being eliminated, and `buildDays` loads that driver's raw `EldEvent` window into memory per call.
2. Load all `DailyLog` rows for the range into Node and aggregate in JS — rejected: unbounded row count in memory for a 90-day/250-driver range, the same shape of mistake as B-055.
3. Aggregate in SQL with `GROUP BY driverId` over the persisted `DailyLog` header (rebuilt nightly/on-write by `hos.recalc`/`LogsService` through `buildDailyLogHeaders`, see D-076), joined to `Driver` only for name/terminal/status filtering and sort.
**Choice:** option 3. `ActivitySummaryGenerator` (`src/modules/reports/generators/activity-summary.generator.ts`) runs one `$queryRaw` CTE (`GROUP BY dl."driverId"`) for the paginated page (with a `COUNT(*) OVER()` window for `total`, avoiding a second count query) and two more `$queryRaw` totals queries (current period, previous period of the same length) for the fleet-wide KPI row — never per-page-only, since a KPI card must summarize the whole filtered driver set, not one page. `sort` is validated against a zod-level whitelist regex and mapped to a column expression through a fixed `Record<SortField, string>` table (`SORT_COLUMNS`); the raw string is never interpolated into SQL (`Prisma.raw` only receives the looked-up column, not user input). Filters (`driverId`/`terminal`/`status`) are cheap because they only touch `Driver`, a ≤ a few hundred-row table, joined once.
**Trustworthiness of `DailyLog`:** verified against the dev DB before committing to this approach — 33,291 rows across 264 drivers, `recalculatedAt` timestamps from the same day, and spot-checked totals (`offSec`/`sbSec`/`drivingSec`/`onSec`/`totalDistanceMi`/`violationCount`/`certified`) that look internally consistent (e.g. one duty status filling the whole day). D-076 (same day, `hos-recalc` agent) already fixed the header staleness this task's brief warned about — every writer of §395 records now rebuilds the header through `buildDailyLogHeaders`, so this endpoint reads the same numbers the RODS grid and the CSV export do, not a second derivation.
**Deltas:** `drivingDeltaPct` is `null` when the previous period (same length, immediately before `from`) has zero `DailyLog` rows for the filtered driver set, or when its `drivingSec` is exactly 0 (division by zero, never faked as 0% or ∞). `violationsDelta` is a plain count delta (`current − previous`), `null` only when the previous period has no data at all — a real previous count of 0 still yields a real (non-null) delta, per "never 0 when unknown, but a genuine 0 is not 'unknown'".
**Figma:** no distinct role-guide page exists for the Activity tab's JSON aggregate (same as the existing `GET /reports/activity` CSV shortcut) — added to `FIGMA_UNMAPPED_ROUTES` with the same reasoning, rather than inventing a `@FigmaScreen` id, so `npm run openapi:gen` / the `x-figma-screens` audit stays honest.
**Dashboard/FMCSA batch equivalent:** the FMCSA pack screen (W-15) and the fleet dashboard both need this same per-driver/date-range shape (they already appear in the brief's contract as consumers), so no separate endpoint was added — `GET /reports/activity/summary` with `driverId` omitted (all drivers) and a 1-day `from=to=today` range covers "today's duty-status totals across the fleet" for the dashboard; `/drivers/roster` and `/live/fleet` answer *current* duty status/position, not day-level totals, so they are not substitutes. Nothing beyond `activity/summary` was built, per the brief's "don't build more than the activity summary unless it's trivial."
**Measured (dev DB, 200+ mock drivers, `connection_limit=2`):** 14-day range ≈ 210–260 ms warm (a lone 714 ms first/cold call, still < 1 s); 90-day range ≈ 52–57 ms warm. `EXPLAIN ANALYZE` on the `DailyLog` scan shows a bitmap index scan on the existing `DailyLog_logDate_idx` (~7 ms execution for a 14-day/3,483-row scan) — no new index needed.
**Why:** matches the brief's explicit instruction ("compute in SQL from DailyLog... do not load events into memory"), stays consistent with the one place headers are derived (D-076), and keeps the KPI/period-delta contract exact (`web/backend-gaps.md` B-46) without adding a second, drifting aggregation path alongside the CSV export.
