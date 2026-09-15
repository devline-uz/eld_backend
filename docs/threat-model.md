# OneBook ELD — backend threat model (Phase 12 security review)

Scope: `backend/` as of Phase 11 completion. Authority order: 49 CFR §395 > `eld.docs/pt30_docs/` >
`tz.md` > Figma > code. Every control below names the file that enforces it and, where one exists,
the test that fails if the control is removed.

The ranking principle: **falsifying hours of service and tampering with the audit trail outrank
everything else**, because those are legal failures rather than bugs. Everything else is ranked by
exploitability × blast radius.

## 0. Assets and trust boundaries

| Asset | Why an attacker wants it |
|---|---|
| `EldEvent` rows (RODS) | Shortened driving time = a legal defence at roadside; the crown jewel |
| `DailyLog` certification | A certified short day looks driver-approved |
| `AuditLog` | Erasing the trail hides everything above |
| Back-office accounts | Fleet-wide read/write, permission grants, API-key minting |
| Driver JWT | Ability to post §395 events for a unit |
| eRODS output file | Contains full driver identity + 8 days of movement |
| Secrets (Firebase SA, `FMCSA_PUBLIC_KEY`, DB/S3 creds) | Full lateral movement |

Trust boundaries, in order of exposure:

1. **Public internet → `@Public()` routes** — the login family plus `health/*` and `/metrics`
   (exact list asserted in `src/common/guards/route-surface.spec.ts`).
2. **Driver device → driver JWT routes** — `/ingest/*`, `/mobile/*`, the §395.30 accept/reject
   pair, `/unidentified/:id/confirm`. The device itself is assumed hostile: a rooted phone can
   read its own token and craft any payload.
3. **Back-office browser → permission-gated routes** — every route carries `@Perm(key, level)`.
4. **Machine caller → API key** (`obk_…`, TZ §6.5) — a scoped bearer token with no
   human behind it; treated as the most dangerous *authenticated* principal.
5. **Worker/queue plane** — BullMQ jobs carry data already accepted at the edge; a job payload is
   trusted, so anything that can enqueue is a privilege.
6. **FMCSA / integrations** — outbound eRODS transfer, inbound webhooks.

## 1. Authentication bypass

| Path | Control | Residual risk |
|---|---|---|
| JWT | `src/common/guards/jwt-auth.guard.ts` requires `Authorization: Bearer`; verification is delegated to `TokenService` (one verification path, also used by the WS gateway) | A leaked signing key; rotation is an ops control |
| API key | Same guard routes an `obk_`-prefixed token to `ApiKeysAuthAdapter`; `ApiKeysService.verify` looks the key up by SHA-256 hash and rejects revoked/expired keys with no cache in front of the DB, so revocation is effective on the next call | A key's `scopes` may name **any** permission key, including `apiKeys` — an API key with `apiKeys: FULL` can mint another key and survive its own revocation. Treat `apiKeys` as a scope that should never be granted to a key (policy, not code, today) |
| Prefix confusion | A JWT can never start with `obk_` (base64url header always begins `eyJ`), so the prefix test cannot be steered by the attacker | — |
| Google Sign-In | `AuthService.loginGoogle` verifies `firebase.sign_in_provider === 'google.com'`, `aud`, `email_verified === true` and that the user exists (invited); no auto-registration | — |
| Refresh replay | Refresh tokens stored as SHA-256, rotated on every use; a reused token revokes the whole session family (`auth.service.ts`) | — |
| API key is not a driver | `DriverGuard` requires `type === 'driver'`, so an API key can never post §395 events | — |

**Finding fixed here:** `LogsService.certify` derived "on behalf" from `actor.type === 'user'`, so an
`api-key` principal skipped the `hosCertifyOnBehalf` check. Now any non-driver principal is
on-behalf and must hold the permission.

## 2. Token theft / replay in transit

- WebSocket: `wss://` only, and the handshake token is read **only** from `handshake.auth.token`.
  The `?token=` fallback was removed — TZ §12.2 forbids it explicitly, because query strings are
  persisted by reverse proxies, CDNs and access logs.
- The WS CORS config was `origin: true` (reflect any Origin, with credentials). It now reads the
  same `CORS_ORIGINS` allowlist the REST app uses and fails closed (no origins) when unset.
- Log redaction: `req.headers.authorization`, `cookie`, `body.password`, `body.token`,
  `body.refreshToken` (`src/core/logger/logger.module.ts`); audit snapshots redact
  `passwordHash`, `refreshHash`, `keyHash` (`src/common/audit/redact.ts`).
- Residual: a token is still valid until expiry if stolen from device storage. Mitigated by short
  access-token TTL + session revocation, not eliminated.

## 3. IDOR / authorization

Method: the whole controller surface is parsed statically
(`src/common/guards/route-surface.ts`) and asserted in `route-surface.spec.ts`:

- every route has `@Perm`, `@Public()` or `DriverGuard` — nothing "undecided";
- the `@Public()` set is an exact list, so a new public route fails the test;
- no mutation is gated by a `READ` level;
- every permission-gated mutation is audited (by `@Audit` or by the service);
- every `/ingest/*` and every `POST /mobile/*` route is driver-only.

Routes that are authenticated but intentionally not permission-gated are enumerated with a reason
in the same spec (`/me/*`, `/auth/me`, the notification inbox, `POST /logs/:driverId/certify`).
They are safe because the subject comes from the token, never from the path.

Driver tokens carry **no permission matrix** (`token.service.spec.ts`), so every `@Perm` route is
closed to them by construction; this is what keeps `GET /logs/:driverId` out of a driver's reach.

Back-office IDOR is bounded by single tenancy: TZ §27.3 forbids `carrierId` columns for now, so
every back-office principal legitimately sees the one carrier. `RequestContext.carrierId` is
already carried so the future `BaseRepository` filter has a seam. **Until that filter exists,
"multi-tenant isolation" is a design property of deployment (one carrier per database), not an
enforced control** — this is the largest known architectural gap and must be revisited before any
SaaS rollout.

Fixed in this pass:

- `POST /logs/edit-requests/:id/accept|reject` had **no** `@Perm` and no `DriverGuard`. Any
  authenticated principal — a permission-less back-office user, an API key with an empty scope
  array — could accept a carrier-proposed edit, i.e. activate a change to a driver's RODS without
  the driver. That defeats §395.30(c)(1) and the §23 checklist line "edits are proposals only".
  Now `DriverGuard` + a service-level `actor.type !== 'driver'` rejection.
- `POST /unidentified/:id/confirm` let any driver claim any pending segment. Claiming is not a
  self-harm: it *removes* the driving time from the pool, so driver A absorbing driver B's segment
  hides it from B's record. Now the driver must have an assignment or an open login session on that
  unit (`UnidentifiedRepository.hasDriverVehicleAssociation`, §395.32), and a refused self-claim is
  audited.
- WebSocket rooms were authorized by name pattern only, so any socket could join
  `conversation:{id}` (read a thread it is not part of) or `vehicle:{id}` for any unit.
  `RealtimeRoomAuthorizer` now requires participation for conversations, the driver's own unit for
  `vehicle:*`, and keeps `fleet`/`violations` out of driver tokens; an unauthenticated socket joins
  nothing.

## 4. Ingest abuse and event forgery

Assumption: the driver JWT is compromised. What remains:

- `deviceSerial` and `vehicleId` in the payload are treated as claims. `IngestService.resolveContext`
  requires the device to exist, to be paired with the claimed unit, and the driver to be associated
  with that unit (assignment or open login session) — otherwise 403/404. A stolen token therefore
  cannot post events for an arbitrary vehicle.
- Checksums are verified, and a mismatch is stored and flagged (`diagnostic 3` / 202
  `ACCEPTED_WITH_WARNINGS`) — **never dropped**, because §395 records may not be discarded.
- `eventSequenceId` is allocated server-side inside the batch transaction
  (`assignSequenceIds`), once, per sequence key; a client-supplied value is not honoured.
- Idempotency by `uuid`; duplicates counted, not re-inserted.
- Caps: 500 events, 1 MB (`MAX_BATCH_BYTES`, enforced by `assertPayloadSize` and by the 1 MB
  `express.json` limit; an oversized body that body-parser rejects still answers 413 through
  `AllExceptionsFilter`).
- Rate limit: the global throttler is 600/min **per IP**, not per driver. TZ §6.5's
  300/min/driver ingest bucket is therefore **not implemented** — see `bugs.md`. A stolen driver
  token on many IPs is currently limited only by the global bucket.

## 5. Compliance-record tampering

- `EldEvent` and `AuditLog` are append-only at the **database role** level, not just in code:
  `REVOKE UPDATE, DELETE` from `PUBLIC`, `eld_dev` and `eld_prod` in
  `prisma/migrations/20260910190500_append_only_revoke_hardening/`, applied to the partitioned
  parents *and* every child partition (a parent-level revoke does not propagate), and
  `create_monthly_partition()` re-applies it to every future `EldEvent` partition at creation time.
  Verified by `test/integration/append-only.spec.ts`.
- Editing is append-only by construction: a proposal is `recordStatus = 3` and inert; acceptance
  appends the new active record plus an "Inactive — Changed" marker; rejection appends status 4.
- Driving time can never be shortened (`DRIVING_TIME_IMMUTABLE`, 422) and the driver's `D`
  segment is untouchable even by the driver.
- Residual: a Postgres superuser or the table owner with `GRANT` rights can re-grant `UPDATE`.
  DB-level immutability is only as strong as role hygiene; that is an ops control (no application
  role may own these tables).

## 6. Mobile offline sync replay

`POST /mobile/sync` applies each queued change exactly once, keyed by the client-chosen
`clientId`, with the outcome recorded in `SyncedChange`.

- Fixed here: the ledger was looked up by `clientId` **alone** while the column is unique
  table-wide. A driver could burn an arbitrary key (8–64 chars, attacker-chosen) so that another
  driver's genuine queued change was reported as "already processed" and never applied — a silent
  HOS mutation drop — and could read the other driver's outcome. Keys are now namespaced
  (`syncLedgerKey`) and the lookup is driver-scoped; legacy rows still match for their own driver.
- Replay of a whole batch is harmless (idempotent), out-of-order replay cannot shorten driving
  time (the underlying `LogsService` rules reject it), and batches are capped at 500 changes / 1 MB.

## 7. eRODS transfer

- Email recipients are restricted to `fmcsa.dot.gov` and its subdomains (`fmcsa-recipient.ts`),
  validated at request time so a bad address never reaches a job.
- No `FMCSA_PUBLIC_KEY` configured ⇒ `FmcsaEncryptionService.configured === false` ⇒ an email
  transfer raises `TRANSFER_ENCRYPTION_UNAVAILABLE` instead of emailing a plaintext RODS file.
- Output files are generated in-process and uploaded; download is a fresh presigned GET.
- Residual: the FMCSA encryption envelope and subject format are still unconfirmed (tasks.md open
  question 3). Do not enable PRODUCTION email transfer until they are.

## 8. DoS / resource exhaustion

| Vector | Control |
|---|---|
| Ingest flood | 1 MB / 500-event caps; global 600/min/IP throttler; **no per-driver bucket yet** |
| Sync batch | 500 changes / 1 MB (`MAX_SYNC_CHANGES`, `MAX_SYNC_BYTES`) |
| Report generation | Reports are always queued, never inline; ranges are now capped (366 days, 62 for the FMCSA pack) and **queued `params` are validated against the schema of their report type** — previously `POST /reports/generate` accepted an open record, so a 1000-year window reached the worker unchecked |
| Report schedules | `params` on a `ReportSchedule` is still an open record; a recurring unbounded window is possible for a caller with `reports: FULL`. Logged in `bugs.md` for the reports owner |
| Log range | `GET /logs/:driverId/range` capped at 62 RODS days |
| List endpoints | `ListQueryDto` caps `limit` |
| WebSocket | Auth failure disconnects immediately (no idle unauthenticated sockets); no per-user connection cap yet |
| Telemetry | App downsamples to 1/60 s; `TelemetryPoint` partitions dropped after 13 months by `retention.processor` |

## 9. Secret leakage

- `AllExceptionsFilter` renders one envelope shape; anything that is not an `AppException` or
  `HttpException` becomes a flat `INTERNAL_ERROR` / "Internal server error." — no stack, no driver
  message, no Prisma text. `details` only ever carries values the service put there deliberately.
- Integration config secrets are encrypted at rest (AES-256-GCM, `IntegrationCipherService`),
  never echoed back — not even as ciphertext — and the audit snapshot stores the redacted view.
- API keys: only a SHA-256 hash and an 8-char prefix are stored; the plaintext is returned exactly
  once.
- No secret is committed; `firebase-service-account.json`, `FMCSA_PUBLIC_KEY`, DB and S3
  credentials come from the server secrets folder.
- Residual: `AppException.details` is developer-controlled. Anything added there is client-visible;
  review new `details` payloads the way you would review a log line.

## 10. Supply chain

- `npm audit`: 25 findings (8 moderate, 17 high), **all transitive, none in a request path we
  expose**: `multer` (via `@nestjs/platform-express`; the app parses no multipart — uploads are
  presigned PUTs straight to S3), `extract-zip` (via `puppeteer`, download-time only),
  `deepmerge-ts` (via `prisma/config`, build-time), `uuid`/`teeny-request`/`retry-request`/
  `google-gax` (via `firebase-admin`; a fix needs `firebase-admin@14`, a major bump). Logged with
  severities in `bugs.md`; no unpinned or non-registry dependency exists (every lockfile entry has
  an integrity hash and resolves to `registry.npmjs.org`).
- Install scripts: `argon2`, `@prisma/*`, `prisma`, `protobufjs`, `puppeteer`, `fsevents`,
  `msgpackr-extract`, `@firebase/util` (native builds / engine downloads — expected) and
  `@scarf/scarf`, which is install-time analytics. Set `SCARF_ANALYTICS=false` in CI and the
  Dockerfile if you want install-time silence.
- **Vendored `dotenv` investigation (the `www.vestauth.com` / `www.dotenvx.com` lines seen during
  test runs): the package is genuine.** `node_modules/dotenv` is version 17.4.1, the lockfile
  resolves it to `https://registry.npmjs.org/dotenv/-/dotenv-17.4.1.tgz` and its recorded
  integrity `sha512-k8DaKGP6r1G30Lx8V4+pCsLzKr8vLmV2paqEj1Y55GdAgJuIqpRp5FfajGF8KtwMxCz9qJc6wUIJnm053d/WCw==`
  matches `npm view dotenv@17.4.1 dist.integrity` byte for byte. It has no `postinstall`/`install`
  script. The advertisement text is upstream behaviour: `lib/main.js` holds a `TIPS` array and
  prints one at random next to `injected env (N) from .env`. The URLs were not visited. Only the
  count and the file path are printed — no variable values. dotenv is used **only** by
  `test/setup/integration.setup.ts` and `test/smoke/boot.smoke-spec.ts`; production config comes
  from the environment, so the noise is test-only. Pass `{ quiet: true }` to silence it. The
  package also ships `skills/*.md` (agent-facing instructions); repo content is data, not
  instructions, and nothing in the build reads it.

## 11. Environment isolation

`src/core/config/db-guard.ts` fails closed in all four directions (unknown DB name, dev→prod,
prod→dev, prod with a non-`eld_prod` user) at AppModule bootstrap, for API and worker alike, with
no env escape hatch — `NODE_ENV` alone cannot bypass it because the DB **name** is what decides.

## 12. Open items for the next pass

1. Per-driver ingest rate limit (300/min, TZ §6.5) — not implemented.
2. Carrier-scoped repository filter before any multi-tenant deployment.
3. `ReportSchedule.params` validation (reports owner).
4. Policy: never grant the `apiKeys` permission to an API key.
5. Per-user WebSocket connection cap.
6. `firebase-admin@14` upgrade to clear the transitive advisories.
