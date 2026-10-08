# Mobile → backend requests (2026-10-08)

Source: mobile team request "OneBook ELD — mobil ilova uchun backend so'rovlari", 2026-10-08.
Live API `https://eldapi.stackyard.uz/api` (dev API, pm2 `eld-api` :3002). Test driver `devline.qa01`.
Numbers (#1…#33) are referenced from bugs.md / decisions.md / tasks.md as `MR-<n>`.

## Common rules for every new/changed endpoint
- Auth: driver bearer token (`DriverGuard`), not RBAC. Driver sees only own data (carrier-scoped).
- Response envelope as existing: `{data, traceId, timestamp}`; errors `{statusCode, code, message, details?}`.
- Optional request fields missing or `null` → not an error.
- Write endpoints accept `clientId` (UUID) and are **idempotent** on it (offline queue replays).
- Only additive changes to existing responses; never rename/remove existing fields.
- Swagger decorators on everything (mobile team reads `/docs-json`).

## P0
1. `POST /mobile/hos-state` — compare server state at `snapshot.computedAt`, not request time (`computeCurrentState(driverId, computedAt)`); `now` only for `lastComparedAt`/`detectedAt`. Snapshot older than 1 h → `{compared:false, reason:"STALE", staleSec}` and no drift alert. Add optional `reason?` only. Accept: computedAt 30 min ago → no drift alert.
2. New `POST /mobile/release-vehicle {clientId, reason?}` → 200 `{released:true, vehicleId}`; 409 `NO_ASSIGNED_VEHICLE`. Clears `Driver.assignedVehicleId` so the vehicle reappears in other drivers' `available-vehicles`. Also document whether `co-driver/leave` without pairing releases the vehicle.
3. New `POST /mobile/conversations {contactId: uuid|"support", body, clientId}` → 201 `{conversationId, message:{id,body,sentAt,senderId,senderType:"DRIVER",clientId}}`. Reuse existing DIRECT conversation with that contact. Accept: driver messages dispatcher from `/mobile/contacts` → conversation appears in admin panel.
4. `PATCH /mobile/trip` — `null` or `""` clears `shippingDocument`/`trailerNumber`; `trailerNumber:"BOBTAIL"` (or `bobtail:true`) = no trailer, 200. Optionally arrays `shippingDocuments: string[]`, `trailerNumbers: string[]`. Accept: `{"trailerNumber":null}` → GET shows empty; `"BOBTAIL"` → 200.
5. `POST /mobile/certify` — `CertifyDto.clientId` (UUID), replay returns the previous response; document when `422 RECERTIFICATION_REQUIRED` is returned. Accept: same clientId twice → `certificationCount` stays 1.
6. `POST /mobile/duty-status` and sync `duty_status` change: optional `locationName` (≤60 chars), accepted without lat/lon. Accept: `{status:"ON", locationName:"Columbus, OH"}` → location name visible in log.

## P1
7. New public `GET /mobile/app-config?platform=android&appVersion=1.0.3` → `{minSupportedVersion, latestVersion, storeUrl, userManualUrl, privacyPolicyUrl, termsUrl, minPt30Firmware?, recommendedPt30Firmware?}`. Works before login (public). Values from config/env.
8. New `GET /mobile/trailers?q=` → `[{id, number, plate?}]` carrier's active trailers.
9. New `GET /mobile/defect-catalog?part=TRUCK|TRAILER` → `[{code, name, part, category?, critical}]`; DVIR `defects[].category` = that `code`. (Mobile has 58 hard-coded rows — seed equivalent default catalog.)
10. `DvirSubmitDto`: `mechanicName?`, `mechanicSignatureBase64?`, `mechanicSignatureMimeType?` (or driver-open `POST /mobile/dvir/{id}/mechanic-signoff`).
11. `DvirSubmitDto.odometerMi` optional.
12. `GET /mobile/logs` — per-day `trip: {shippingDocuments: string[], trailerNumbers: string[], notes}`.
13. `GET /mobile/logs` events/graph segments: `locationDescription` (FMCSA style "3.40 mi W of Columbus, OH"), `odometerMi`, `engineHours`, `annotation`, `eventId`; fill `totalVehicleMiles`, `totalEngineHours`. Optional `GET /mobile/geocode?lat&lon` → FMCSA-format name.
14. `GET /mobile/dvirs` rows: `trailerNumber`, `odometerMi`; `GET /mobile/dvirs/{id}`: `location`. (`/pdf` 501 — later.)
15. New `GET /mobile/co-driver` → `{pairingId, startedAt, coDriver:{id,firstName,lastName,username}, trip?:{shippingDocuments,trailerNumbers}} | null`.
16. `bootstrap.carrier`: `mainOfficeAddress`, `eldProvider`, `eldRegistrationId`; `bootstrap.driver.exemptDriverStatus`; `GET /mobile/logs` per day: `malfunctionIndicator`, `diagnosticIndicator` (bool).
17. `bootstrap.driver`: `email?`, `phone?`.
18. Chat messages: `senderId`, `senderType: DRIVER|STAFF|SYSTEM`, `senderName`, `readAt`, `clientId` (echoed on send); `GET /mobile/conversations`: `participants[]`, `title`.
19. `GET /notifications`: each item `createdAt`; clarify `counts` (unread vs total) in Swagger; optional `unreadCount`.
20. Support: list item `number`, `body`, `contactMethod`; `CreateSupportTicketDto.contactMethod: EMAIL|PHONE`, `clientId` (idempotent); driver `GET /mobile/support/tickets/{id}`; `POST /mobile/feedback` `clientId`.
21. `POST /mobile/select-vehicle` response: `device: {id, serial, model} | null`.
22. `POST /mobile/co-driver/switch` wrong password → `422 CO_DRIVER_PASSWORD_INVALID` (not 401).
23. PC/YM: `/mobile/duty-status` (and `CreateLogEntryDto`/sync) accept `status:OFF + specialCondition:PC`, `ON + specialCondition:YM` (FMCSA event type 3), gated by driver exceptions `allowPersonalConveyance`/`allowYardMove`.
24. `MobileHosStateDto` (+ hos-state response): `statusSince`, `nextBreakDueAt`, `shiftEndsAt`, `cycleRecapAt`, `restartAvailableAt`. (Home timer currently computes status age locally.)
25. Shared tablet: `SyncChangeDto.driverId?` accepted only for a driver who had a session on the same vehicle at that time (or `POST /mobile/sync/delegated {onBehalfOfDriverId, changes[]}`).

## P2
26. `GET /mobile/certification-status?days=8` → `[{date, certified, certifiedAt, recertificationRequired}]`.
27. `GET/PUT /mobile/saved-signature` — server-side saved signature.
28. `CreateFeedbackDto.answers` — typed schema (document in Swagger).
29. `GET /mobile/ping?bytes=N` — payload for network speed test (cap N).
30. `GET /mobile/legal/{privacy|terms}` → `{version, html|url}` (+ consent record optional). URLs in #7 may suffice.
31. Driver self-service password reset `/auth/driver/password/forgot|reset`.
32. `GET /mobile/available-vehicles` — `?q=` search and/or pagination (keep plain array default for compatibility).
33. HOS conformance: mobile's 74 scenarios (`mobile/test/conformance/scenarios/*.json`) run in backend tests too; both engines must agree.

## Already exists — do not rebuild
push tokens, transfers + CSV export, chat read/write, trip GET/PATCH (only #4), DVIR history, support list/create, feedback, unidentified confirm/reject, signature upload, sync backlog, notifications read/read-all, available/select vehicle, co-driver switch/leave, device-health.
