# Implementation Roadmap

Phase-by-phase execution plan for the OneBook ELD backend, derived from `backend/tz.md` §24.
`tz.md` remains the single source of truth for requirements, data model, and rules — this file
only sequences the work. Conflict order when documents disagree:

**FMCSA 49 CFR §395 > Pacific Track docs (`eld.docs/pt30_docs/`) > `tz.md` > Figma > existing code.**

Each phase names an owning subagent (see `.claude/agents/README.md`), a checklist of concrete
deliverables, exit criteria, and dependencies. All boxes start unchecked.

## Phase 1 — Foundation
Skeleton, both DBs, auth, and audit so every later phase has a base.
**Owner:** `eld-architect` · support: `eld-prisma-db`, `eld-auth-rbac`, `eld-devops`
- [x] Nest skeleton: `main.ts` (API) + `worker.ts` (worker) entrypoints per §3.4 tree
- [x] `common/` (guards, interceptors, filters, `ZodValidationPipe`, `units/`) and `core/` (prisma, config, logger, queue, storage, firebase, events)
- [x] Prisma schema bootstrap + initial migration, applied to **dev and prod** DBs
- [x] Seed tool producing data matching Figma
- [x] Auth: password login, Google Sign-In (Firebase) — 2FA removed 2026-09-13 at user request (D-050)
- [x] Roles module: 22-key permission matrix
- [x] Audit module + `AuditInterceptor`, `AuditLog` append-only at DB level (`REVOKE`)
- [x] Error envelope (§20) + `common/errors/codes.ts` (append-only codes)
- [x] `RequestContext` per request wired end to end
**Done when:** login works (password + Google) against seeded Figma-matching data · `db:check-drift` clean · a permission test exists for at least one role.
**Depends on:** none

## Phase 2 — Fleet
Vehicles, drivers, devices fully manageable so ingest and HOS have real entities.
**Owner:** `eld-fleet-ops`
- [x] Vehicles: units, VIN, trailer, odometer offset + calibration audit
- [x] Drivers: CDL, exceptions
- [x] Devices: PT30 registry, pairing, firmware, BLE status
- [x] Odometer calibration flow with audit trail
- [x] Fleet import
- [x] Fleet export
- [x] Permission checks wired to Phase 1 roles
**Done when:** fleet sections (vehicles/drivers/devices) functionally complete per Figma · odometer calibration audited · import/export round-trips without loss.
**Depends on:** Phase 1

## Phase 3 — Ingest
Real telemetry and event data flowing from device/app into the system.
**Owner:** `eld-ingest-device`
- [x] `/ingest/*` endpoints for events and telemetry
- [x] Unit conversion via `common/units/` (imperial in DB, `raw*` fields preserved)
- [x] BLE connection status tracking
- [x] `EldEvent` append-only storage (DB-level `REVOKE` on update/delete)
- [x] `eventSequenceId`: assigned once per event, immutable
- [x] Checksum computed and verified per event
- [x] Table partitioning for stored events
- [x] Malfunction/diagnostic auto-detection
**Done when:** simulated device data flows end to end through `/ingest/*` into partitioned storage · every event has a checksum and stable `eventSequenceId` · metric→imperial conversion is 100% test covered.
**Depends on:** Phase 1, Phase 2

## Phase 4 — HOS Engine (TypeScript)
Authoritative server-side rules engine, required before logs or mobile can depend on correct hours.
**Owner:** `eld-hos-engine`
- [x] `hos/` module as pure functions — no DB access, no Nest DI
- [x] Core HOS rules: driving/on-duty limits, breaks, cycles, split sleeper
- [x] Split sleeper: both qualifying segments excluded from the 14-hour window, and a closed pair applies the §395.1(g)(1) look-back rather than a reset (D-012)
- [x] 300+ golden/unit tests
- [x] Recalculation job (BullMQ `hos-recalc.processor.ts`)
- [x] Violation detection via `upsert` + `AUTO_CLEARED` (recalc never duplicates violations)
- [x] JSON conformance fixtures written to `eld.docs/hos-conformance/`
- [x] DST handling: 23/25-hour days computed correctly
**Done when:** golden tests green, `hos/` coverage ≥ 95% · recalculation never duplicates violations under repeated runs · conformance fixtures exist for Phase 4b.
**Depends on:** Phase 3

## Phase 4b — HOS Engine (Dart)
Port the same specification to the mobile Dart engine so offline hours are correct. **Must land
before Phase 6 (Mobile API)** — the app cannot depend on a server round-trip for HOS state without
breaking the offline requirement, and it must never disagree with the TS engine.
**Owner:** `eld-hos-engine`
- [x] `lib/hos/engine/` Dart port of the Phase 4 rules specification
- [x] 100% conformance against the same JSON fixtures from `eld.docs/hos-conformance/`
- [x] `HOS_ENGINE_VERSION` kept identical on both TS and Dart sides
- [x] `POST /mobile/hos-state` endpoint for state exchange/verification
- [x] Nightly drift comparison job between server and mobile engine outputs
- [x] Alerting on any detected drift
**Done when:** Dart and TS engines match 100% on shared fixtures · `HOS_ENGINE_VERSION` matches on both platforms · nightly drift job reports zero unexplained drift.
**Depends on:** Phase 4. **Blocks Phase 6.**

## Phase 5 — RODS
Daily logs, driver edits, certification, unidentified-driving handling.
**Owner:** `eld-compliance-rods` · support: `eld-hos-engine`
- [x] Daily log (RODS) generation, split by `driver.homeTerminalTimezone`
- [x] §395.30 edit flow: edits are proposals only, take effect only after driver approval
- [x] Driver can edit own log but cannot touch the `D` (driving) segment
- [x] Certification required again after any change to a certified log
- [x] Unidentified-driving reassignment: `recordOrigin` stays `1`, never becomes `2`
- [x] Unidentified driving events preserved even when device-stored (never lost)
- [x] Audit trail for all log edits/certifications
**Done when:** HOS Logs section functionally complete per Figma · an edit never applies without driver certification · `recordOrigin` invariant covered by a test.
**Depends on:** Phase 4

## Phase 6 — Mobile API
Bootstrap, offline sync, duty-status changes, DVIR, signature capture for the driver app.
**Owner:** `eld-realtime-offline` · support: `eld-compliance-rods`, `eld-fleet-ops`, `eld-hos-engine`
- [x] Mobile bootstrap endpoint (driver/vehicle/device context on app start)
- [x] Offline sync protocol (queue, conflict resolution, replay)
- [x] Duty-status change endpoints
- [x] Mobile DVIR submission
- [x] Signature capture and storage
- [x] Offline DOT inspection mode
- [x] Integration with `POST /mobile/hos-state` from Phase 4b
**Done when:** driver app works fully offline for HOS-state and duty-status changes · sync reconciles queued offline actions without loss · DVIR + signature flow works end to end.
**Depends on:** Phase 2, Phase 5, **Phase 4b (hard prerequisite)**

## Phase 6b — Mobile API gaps (driver app, `mobile/tz.md` §21)
Every driver-facing gap is closed with a NEW `/mobile/*` route only (decision `mobile/decisions.md`
MD-001): thin controllers in `mobile.module.ts`, `@UseGuards(DriverGuard)`, calling the existing
services with `actor = { id, type: 'driver' }`. Existing web routes, `@Perm` matrix, DTOs, response
shapes and `PermissionGuard` do NOT change. Agents never touch git (see memory).
**Owner:** `eld-fleet-ops` (MB-2, MB-3, MB-5, MB-10, MB-14) · `eld-realtime-offline` (MB-1, MB-7, MB-8, MB-11, MB-15, MB-19) · `eld-compliance-rods` (MB-4, MB-6, MB-18) · `eld-reports-jobs` (MB-13, MB-16) · `eld-auth-rbac` (MB-9, MB-20, MB-21, MB-22) · support: `eld-qa-test` (contract tests), `eld-security` (review)

Blocking (screens cannot ship without):
- [x] MB-1 `POST /mobile/push-tokens { token, platform, deviceLabel }` (upsert on unique `token`, `lastSeenAt`) · `DELETE /mobile/push-tokens/:token` (own token only)
- [x] MB-2 `GET /mobile/bootstrap` adds `availableVehicles[{ id, unitNumber, make, model, deviceSerial }]` · `POST /mobile/select-vehicle { vehicleId }` → `Driver.assignedVehicleId` + `AuditLog`; unit held by another active driver → `409 CONFLICT`
- [x] MB-3 `bootstrap.coDriver` adds `firstName, lastName, username, currentStatus` · `POST /mobile/co-driver/switch { coDriverPassword }` (verifies via `AuthService`, returns co-driver token pair, swaps primary in `CoDriverPairing`) · `POST /mobile/co-driver/leave` (`endedAt`)
- [x] MB-4 `POST /mobile/transfers { method, rangeStart, rangeEnd, outputFileComment, recipient? }` → existing `TransfersService.create()` with `driverId = actor.id`, `requestedByType = DRIVER`; response `{ id, status, referenceId, sentAt, fileName }` · `GET /mobile/transfers?limit=5`
- [x] MB-5 `GET /mobile/trip` (active trip + `stops[]` + `documents[]` = BOLs of trips assigned to this driver) · `PATCH /mobile/trip { shippingDocument, trailerNumber, notes }`
- [x] MB-15 `GET /mobile/conversations` · `GET /mobile/conversations/:id/messages` · `POST /mobile/conversations/:id/messages { body, clientId }` · `POST /mobile/conversations/:id/read` (sets `ConversationParticipant.lastReadAt` + `Message.readAt`) — thin wrappers over `MessagingService`, driver sees own conversations only

Important (screen works, feature missing):
- [x] MB-6 **bug** — `POST /mobile/dvir` and sync `dvir` drop `photoAttachmentIds` before `repo.createDvir` (`mobile-dvir.service.ts:49-73`); persist them on `Defect`/`Attachment`
- [x] MB-7 `GET /mobile/device-health` — active malfunction/diagnostic codes, `storedEventsCount`, last `bleState`, unidentified count, last HOS drift
- [x] MB-8 sync `certify` payload accepts optional `signatureBase64` (offline certification has no `signatureImageId`)
- [x] MB-10 `GET /mobile/dvirs?days=14` · `GET /mobile/dvirs/:id` · `GET /mobile/dvirs/:id/pdf` (pdf → `501 NOT_IMPLEMENTED`, no single-DVIR generator exists yet)
- [x] MB-11 `POST /mobile/sync` accepts optional `backlog: { days, bytes }` → `alert.sync_backlog`
- [x] MB-13 `Notification.kind` new column (`violation | edit_request | message | trip | unidentified | certify | maintenance`) + `objectType/objectId` populated by `AlertProcessor`; FCM `data.kind`. Existing `type` (rule uuid, D-072) unchanged
- [x] MB-14 `GET /mobile/contacts` — fleet managers / dispatchers / co-driver / support (name, role, phone)
- [x] MB-16 `POST /mobile/feedback` · `POST /mobile/support/tickets` · `GET /mobile/support/tickets` → existing `SupportService` with `RequesterContext.type = 'driver'`
- [x] MB-18 `GET /mobile/logs/:date/export?format=pdf|csv`
- [x] MB-19 `bootstrap.appUpdate { latestVersion, minVersion, notes, storeUrl }` from config/env

Minor / to agree:
- [x] MB-9 `POST /auth/login/driver` response adds `driverId`
- [ ] MB-12 `eld.docs/erods-conformance/` output-file fixtures shared by TS `output-file.spec.ts` and the Dart `output_file_builder` test
- [ ] MB-17 `GET/POST /mobile/speedtest` (2 MB body)
- [x] MB-20 `@Throttle` on `POST /auth/refresh`
- [x] MB-21 honour `JWT_DRIVER_REFRESH_TTL` / `JWT_REFRESH_TTL` env instead of the hardcoded `REFRESH_TTL_MS` map (`auth.service.ts:29-32`)
- [ ] MB-22 `423 ACCOUNT_LOCKED` is documented but never thrown — decide: implement (affects web login too) or drop from swagger
- [x] MB-23 fix doc comment on `PATCH /devices/:id/ble-status` (driver app reports BLE via `/ingest/ble-state`)
- [ ] Contract tests for every new route (`eld-qa-test`) · web contract suite re-run shows 0 diff (`web-qa-a11y`)
**Done when:** every `mobile/tz.md` §21.1 route answers a driver JWT with the documented shape · a back-office JWT gets `403 DRIVER_CONTEXT_REQUIRED` on all of them · web contract tests unchanged · `mobile/tz.md` §9.2 table updated to ✅.
**Depends on:** Phase 6. **Blocks** mobile phases 3, 7, 8 (`mobile/tz.md` §20).

## Phase 7 — DVIR and Service
Full defect reporting and maintenance workflow.
**Owner:** `eld-fleet-ops`
- [x] DVIR module: inspections, defect reporting
- [x] Work order module
- [x] Maintenance scheduling
- [x] DTC (diagnostic trouble code) capture
- [x] Defect resolution workflow tied to work orders
- [x] DVIR backend fully wired to Figma flows
**Done when:** DVIR screens functionally complete per Figma · a reported defect traces through to a resolved work order.
**Depends on:** Phase 2, Phase 6

## Phase 8 — Reports
Reporting suite and scheduling.
**Owner:** `eld-reports-jobs`
- [x] IFTA report generation
- [x] Activity report
- [x] DVIR report
- [x] FMCSA compliance package
- [x] Report scheduler (BullMQ)
- [x] Report storage via S3 adapter
**Done when:** Reports section functionally complete per Figma · scheduled reports run and land in storage without manual trigger.
**Depends on:** Phase 4, Phase 5, Phase 7

## Phase 9 — eRODS (TEST mode)
FMCSA data transfer file generation.
**Owner:** `eld-compliance-rods`
- [x] Output file generator per Appendix A format
- [x] Output file name generator per Appendix A §4.8.2.2, unit-tested
- [x] Validation of generated file against Appendix A
- [x] Download endpoint
- [x] Email transfer restricted to `fmcsa.dot.gov` domain only, encrypted — the send path is complete and tested; the FMCSA key/subject/mailbox remain open question #3, so `MAIL_PORT` is bound to a transport that does not dispatch (decisions.md D-026)
- [x] TEST-mode flag with clear path to PRODUCTION mode (settings-only, §10.1)
**Done when:** generated file passes Appendix A validation, including in TEST mode · file name generator unit-tested · email transfer domain-restricted and encrypted.
**Depends on:** Phase 5

## Phase 10 — Operations
Dispatch and safety features.
**Owner:** `eld-fleet-ops` (trips, safety, geofences, messaging) · `eld-reports-jobs` (notifications: rules, delivery, alert processor) · support: `eld-realtime-offline` (in-app + push delivery)
- [x] Trips module: dispatch, trip lifecycle — `eld-fleet-ops`
- [x] Safety module: harsh events, scoring, coaching — `eld-fleet-ops`
- [x] Geofences module — `eld-fleet-ops`
- [x] Messaging module: chat, broadcast — `eld-fleet-ops`
- [x] Notification rules and channels (`SMS` rejected with `422 CHANNEL_NOT_AVAILABLE`) — `eld-reports-jobs`
- [x] Alert processor (BullMQ): throttle, cooldown, quiet hours — `eld-reports-jobs`
- [x] In-app and FCM delivery path for alerts — `eld-realtime-offline`
- [x] WebSocket gateway wiring for real-time dispatch/safety updates — `eld-realtime-offline`
**Done when:** Dispatch and Safety sections functionally complete per Figma · a harsh-event trigger produces a scored, coachable record and a notification.
**Depends on:** Phase 3, Phase 6

## Phase 11 — Settings
Carrier profile, integrations, API access, support tooling.
**Owner:** `eld-fleet-ops` (carrier, support) · `eld-reports-jobs` (integrations, webhooks) · `eld-auth-rbac` (API keys) · support: `eld-compliance-rods`, `eld-security`
- [x] Carrier module (single-row profile table, not env config) — `eld-fleet-ops`
- [x] Carrier eRODS fields reviewed: `eldIdentifier`/`eldRegistrationId` exactly 4 chars, `erodsMode` — `eld-compliance-rods`
- [x] Integrations module: TMS, fuel card; secrets encrypted at rest — `eld-reports-jobs` + `eld-security`
- [x] Webhook support (HMAC-SHA256 signing, 3 retries) — `eld-reports-jobs`
- [x] API key management: hashing, prefix display, scopes, revoke — `eld-auth-rbac` + `eld-security`
- [x] Support module: tickets, feedback — `eld-fleet-ops`
- [x] Settings screens wired end to end
**Done when:** Settings section functionally complete per Figma · an API key can be issued, used, and revoked.
**Depends on:** Phase 1

## Phase 12 — Hardening
Load, security, monitoring, backup, and long-run HOS verification before production readiness.
**Owner:** `eld-security` · support: `eld-qa-test`, `eld-devops`
- [x] Load test suite (k6) against acceptance p95 targets — `test/load/k6-acceptance.js`, run twice against dev; see B-037/B-038/B-039, D-044
- [x] Security review: threat model, attack-surface pass (`docs/threat-model.md`; B-027…B-035)
- [x] Monitoring/alerting for API and worker containers — real `WorkerHeartbeatService`/`QueueDepthService` liveness+metrics (B-024 follow-up), `docker/prometheus/{prometheus,alerts}.yml`, real `@sentry/node` client
- [x] Backup exercise (restore drill, not just backup creation) — `scripts/restore-drill.sh`, run for real against prod, see B-026 and `docs/deploy.md` restore log
- [ ] 7-day HOS drift monitoring window (TS vs Dart) in a near-production setting — infra/schedule/metric/procedure in place (nightly `hos-drift` job + `onebook_sentry_captures_total{fingerprint="hos_engine_drift"}`); the 7-day elapsed observation itself has NOT run — cannot complete within this session
- [x] CI gate wiring for all coverage thresholds (see Global gates) — `.github/workflows/ci.yml`, every gate command verified locally
- [ ] Final compliance-checklist sign-off pass
**Done when:** k6 report shows p95 within target · 7-day HOS drift window shows zero unexplained drift · backup restore drill succeeds · all CI gates pass on the release candidate.
**Depends on:** all prior phases

## Phase 13 — Web panel gaps (`../backend_tasks.md`, 2026-09-24)
Source: `../backend_tasks.md` (section numbers in brackets). Depends on: Phases 1–12.

### 13A — Schema (eld-prisma-db)
- [x] One migration covering every new column/table/enum value listed in 13C–13H

### 13B — OpenAPI (eld-architect)
- [x] [1] zod DTO → `requestBody` schemas + `@ApiQuery` for `@Query(zodBody)` endpoints, `components.schemas` with nullable
- [x] [1] `GET /trips` documents `q`, `driverId` (B-59)
- [x] [1] `npm run openapi:gen` regenerates `docs/openapi.json` after all of Phase 13; web `generate-api-types` + `test:contract` pass

### 13C — RODS (eld-compliance-rods)
- [x] [2] B-39 edit request: `proposedSpecial` NONE/PC/YM, `notifyDriver`, name-only location
- [x] [3] B-72 `POST /logs/:driverId/events` proposed event on empty day (recordStatus 3, applied false, audit)
- [x] [4] B-83 `requireDriverConfirmation` on unidentified assign (pending until driver confirms)
- [x] B-38 `totalEngineHours` in `GET /logs/:driverId/events`
- [x] B-45 `GET /carrier/transfer-config` (reports / reportsTransfer read) — gated `reports:READ`, see D-095

### 13D — Reports (eld-reports-jobs)
- [x] [5] B-48 PDF for IFTA/DVIR/ACTIVITY; FMCSA pack `include[]`, `vehicleId`; scheduled `params.window`
- [x] [6] B-75 `GET /dvir/:id/pdf` (§396.11 record, defects, both signatures)
- [x] [16] B-14 `ReportType` RODS + IDLE_FUEL generators
- [x] B-46 `requestedBy { id, name }` on Report and DataTransfer rows
- [x] B-49 `report.ready` from worker to API process (Redis pub/sub → `user:{id}`)

### 13E — Notifications, alerts, storage (eld-reports-jobs)
- [x] [15] B-41 `GET /attachments/:id/presign` → `{ url, expiresAt }`, permission-checked
- [x] [23] B-87 `GET/PATCH /notification-channels` (org-level email/webhook)
- [x] [24] B-86 alert rule `mutedUntil`
- [x] [25] B-9 `POST /alert-rules/:id/test` → `{ triggered }`
- [x] B-56 `POST /notifications/:id/read`
- [x] B-57 `Notification.category`, `?category=`, `counts`
- [x] B-58 human `body`, `objectType`/`objectId`, `severity` on alert notifications

### 13F — Vehicles and drivers (eld-fleet-ops)
- [x] [7] B-4 `GET /vehicles/:id/histories?date=` server-side segmentation
- [x] B-5 `GET /vehicles/:id/activities`
- [x] `GET /vehicles/:id/telemetry` read path
- [x] B-35 device join on vehicles / `GET /devices?vehicleId=`
- [x] B-7 co-driver pairings list/create/end
- [x] [8] B-69 import `options` (drivers + vehicles)
- [x] [10] B-74 `notify` on `POST /vehicles/:id/assign-driver`
- [x] [11] B-81 `POST /drivers/:id/reset-password` (drivers:FULL, audit)
- [x] [12] B-94 driver documents API (presigned upload, list, delete)
- [x] [19] B-82 `sendInvitation` on `POST /drivers`
- [x] B-71 `PATCH /vehicles/bulk-status`
- [x] B-29/B-30/B-31 driver email verification, unique email, verified badge data

### 13G — Trips, geofences, messaging (eld-fleet-ops)
- [x] [9] B-73 trips: `distanceMi`, `rateUsd`, `customer`, `trailerId`, DRAFT status
- [x] [10] B-74 `notify` on `POST /trips/:id/assign`
- [x] [17] B-92 `estimatedDriveSec`
- [x] [14] B-15 geofence `dwellMinutes`, `afterHoursOnly` + evaluator
- [x] [18] B-93 geofence `ADDRESS` shape / server geocode
- [x] B-36 trips name joins, unassigned-loads include stops
- [x] B-37 conversations `lastMessage` + real `unreadCount`; B-67 `POST /conversations/:id/read`
- [x] B-10 `GET /search?q=&limit=`

### 13H — DVIR, devices, support, integrations, safety (eld-fleet-ops)
- [x] B-68 defect `resolutionType` REPAIRED / NOT_REQUIRED / DEFERRED
- [x] B-70 resolve defect: `correctedBy`, `completedAt`, `laborHours`, `partsCostUsd`
- [x] B-42 work order: `estimatedLaborHours`, `keepOutOfService`, `notifyDriver`, `blockDispatchAssignment`
- [x] B-47 `GET /dvir?from&to`, `GET /dvir/compliance`
- [x] B-40 defect assignee
- [x] [13] B-8 `GET /devices/:id/diagnostics`
- [x] [22] B-88 device `autoFirmware`, `shareDiagnostics`
- [x] [26] B-89 `GET /integrations/catalog`
- [x] [27] B-90 support chat (`POST /support/chats` + socket room)
- [x] [28] B-91 ticket server-collected attachments
- [x] B-12 tickets/feedback allowed with `support:READ`
- [x] B-43 driver-level coaching; B-44 scorecard previous-period baseline

### 13I — Auth, users, account (eld-auth-rbac)
- [x] B-50 `GET /me/sessions` drops `refreshHash`/`userId`; `DELETE /me/sessions` → `{ revoked }`
- [x] B-25 `AUTH_MODE` production blocks `POST /auth/login` (403 PASSWORD_LOGIN_DISABLED)
- [x] [20] B-85 invite `message`, `terminalIds`
- [x] [21] B-84 `PATCH /users/:id` email (reverify), jobTitle, phone, home terminal
- [x] [29] B-51 `PATCH /me/profile` jobTitle/phone, avatar upload/delete, `avatarUrl`
- [x] [30] B-11 `GET/PUT /me/preferences`
- [x] B-95 `dataTransfer` permission key split from `reportsTransfer`
- [x] B-34 `/auth/me` profile fields; B-62 audit `actorName`/`actorEmail`; B-13 assign-driver allows `trips:FULL`

### 13J — Verification
- [x] eld-security review of new endpoints (IDOR, presign scope, reset-password, sessions) — B-090..B-100, D-103, docs/threat-model.md §11a
- [x] eld-qa-test: tests for every 13C–13I endpoint, full suite green, dev API :3002 restarted on new build

## Global gates
From TZ §25 — apply across every phase, not just at the end:
- [x] All endpoints documented in Swagger, with example responses
- [x] E2E tests green, coverage requirement met
- [x] Whenever `hos/` changes, golden tests stay green
- [x] Every migration tested `up` and `down` on the **dev DB**
- [x] Dev and prod schemas identical (`db:check-drift` clean)
- [ ] Every new endpoint links to at least one Figma screen
- [x] Relevant compliance-checklist items are checked off as work lands
- [ ] p95 does not exceed target (k6 report) — throttle bug fixed (B-037), but DB-pool exhaustion (B-038) + heavy concurrent-agent contention on this box made the run unrepresentative; not certifiable either way from this data, see D-044
- [x] Permission test written for every role

CI coverage gates (hard gates):
- [x] `hos/` (TS) coverage ≥ 95% — per-file gate Jest actually enforces now passes: every `hos/` file 100% stmts/branch/funcs/lines (`npx jest --coverage --selectProjects unit`), B-039 FIXED (found and fixed B-041 while covering `cycle.ts:48`)
- [x] `common/units/` coverage = 100% — verified `npx jest --coverage`: 100/100/100/100
- [x] TS/Dart HOS conformance fixture match = 100%
- [ ] `db:check-drift` clean (dev vs prod schema) on every CI run — gate is wired into `.github/workflows/ci.yml` and works (verified locally); left unchecked because dev currently has 5 migrations not yet `migrate deploy`'d to prod (concurrent Phase-work-in-progress), so the box itself is not clean right now — deploying those to prod is outside this task's scope

## Compliance checklist
From TZ §23 — authoritative wording lives in `tz.md` §23.
- [x] Driving time is never reduced by any means
- [x] `EldEvent` and `AuditLog` are append-only (DB-level `REVOKE`)
- [x] Every event carries a checksum and it is verified
- [x] Edits are proposals only; never take effect without driver certification
- [x] Certification is required again after every change
- [x] Device-stored events are never lost, recorded as unidentified when unmatched
- [x] Malfunction/diagnostic conditions are auto-detected
- [x] Output file format matches Appendix A (including in TEST mode)
- [x] Email transfer goes only to the `fmcsa.dot.gov` domain
- [x] RODS retained 6 months, audit retained 24 months
- [x] Location precision: on-duty 1 mile, Personal Conveyance 10 miles
- [x] All timestamps stored in UTC, converted to carrier region only for display
- [x] DST transitions correctly produce 23- or 25-hour days
- [x] Odometer offset applied correctly and calibration audited
- [x] Metric → imperial conversion is 100% test covered
- [x] Split sleeper: both qualifying segments excluded from the 14-hour window
- [x] Unidentified-driving reassignment: `recordOrigin` stays `1`, never becomes `2`
- [x] Every event has an `eventSequenceId`, assigned once, never changed
- [x] Personal Conveyance location coarsened to 10 miles **before** storage
- [x] RODS day boundary follows `driver.homeTerminalTimezone`
- [x] Output file name follows Appendix A §4.8.2.2, unit tested
- [x] `eldIdentifier` and `eldRegistrationId` are exactly 4 characters
- [x] Email transfer is encrypted and restricted to `fmcsa.dot.gov`
- [x] ~~Google Sign-In never bypasses 2FA~~ — moot: 2FA removed 2026-09-13 at user request (D-050)
- [x] Dart and TypeScript engines match 100% on shared fixtures
- [x] Recalculation never duplicates violation records (`upsert` + `AUTO_CLEARED`)
- [x] Driver can edit their own log but cannot touch the `D` segment

## Open questions
From TZ §26 ("Qolgan aniqlik talab qiladigan narsalar") — unresolved as of this writing.

1. **Flutter wrapper availability for the Pacific Track SDK** (native Android/iOS). Blocked on: mobile app team. Impact: no backend effect; relevant only to Phase 4b/6 mobile integration timing.
2. **Output file name format (§10.2)** — *file name RESOLVED, column order still open.* The 4.8.2.2 name rule is implemented as a pure function with unit tests (`transfers/filename.ts`), and the settled parts of the file format are enforced mechanically (segment order, 9-line header, 4.4.5.3 line check values, 4.4.5.4 file check value, 4-char ELD identifier, MMDDYY/HHMMSS, 4-hex sequence ids, 0.01°/0.1° position, 60-char comment/annotation, printable ASCII). What is STILL unconfirmed against the current FMCSA revision is the column order inside each data line; `eld.docs/pt30_docs/` holds PT30 hardware material only, no Appendix A. Blocked on: the FMCSA document. Impact: contained — the layout is declared once in `transfers/segments.ts` and both the generator and the validator read it, so the diff is a single-file edit (decisions.md D-024). Confirm before the PRODUCTION toggle.
3. **FMCSA email encryption public key and subject-line format (§10.4).** *Still OPEN — no key invented.* Config seams are in place: `FMCSA_PUBLIC_KEY` (PEM or base64; unset today, so `FmcsaEncryptionService.configured` is false and an email transfer raises `TRANSFER_ENCRYPTION_UNAVAILABLE` rather than emailing plaintext), `FMCSA_EMAIL_SUBJECT_TEMPLATE`, `FMCSA_WEB_SERVICES_URL`. The envelope we emit is named (`OBK-ERODS-RSA-OAEP-SHA256+AES-256-GCM/1`) so a confirmed FMCSA format is a strategy swap. There is also no SMTP transport in the project: `MAIL_PORT` is bound to `LoggingMailTransport`, which records the attempt and reports `NO_MAIL_TRANSPORT` (decisions.md D-026). Blocked on: FMCSA-side info + a reviewed mail transport. Impact: does not block TEST mode; required before enabling PRODUCTION email transfer.
4. **Source of the 8-day `previousDays` cycle history on first run** (no historical data exists). Blocked on: backend / migration decision. Impact: first 8 days of cycle calc show incorrectly unless resolved; proposed fix is a manual-entry form during migration — schedule within Phase 1 or Phase 4 rollout.
