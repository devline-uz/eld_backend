# OneBook ELD — Mobil ilova (driver app) API qo'llanmasi

Manba: `backend/docs/openapi.json` (generatsiya: 2026-10-10, backend `main`). Hujjat avtomatik yig'ilgan:
har bir endpoint uchun **nima qiladi**, auth, parametrlar, body maydonlari, javob misoli va xatolar.
Faqat haydovchi ilovasi chaqiradigan endpointlar (`/api/mobile/*`, `/api/ingest/*`, haydovchi auth,
§395.30 tahrir javobi, unidentified tasdig'i, bildirishnomalar, biriktirma URL).

PT SDK 6.11.1 bo'yicha batafsil integratsiya yo'riqnomasi: `backend/docs/pt-sdk-6.11-mobile.md`.

Jami: **72 ta endpoint**, 8 bo'lim.


## Umumiy qoidalar

- **Base URL:** dev `http://<host>:3002/api` (prefiks `/api`); `/health/*` prefikssiz.
- **Konvert:** muvaffaqiyatli javob `{ "data": ..., "traceId": "...", "timestamp": "..." }` ko'rinishida keladi (quyidagi misollarda `data` ichidagi qism ko'rsatilgan). `GET /mobile/ping` va fayl yuklash endpointlari konvertsiz.
- **Xato formati:** `{ "statusCode": 422, "code": "VALIDATION_FAILED", "message": "...", "details": { ... }, "traceId": "...", "timestamp": "..." }` (support'ga murojaatda `traceId` ni yuboring). Asosiy kodlar: `400/422 VALIDATION_FAILED`, `401 UNAUTHORIZED`, `403 FORBIDDEN` / `DRIVER_CONTEXT_REQUIRED`, `404 NOT_FOUND`, `409 CONFLICT`, `413 PAYLOAD_TOO_LARGE`, `429` (throttle).
- **Pagination:** ro'yxatlar odatda `?page=&limit=` → `{ items, page, limit, total, totalPages }`; ba'zilari cursor (`?cursor=`) — har endpointda ko'rsatilgan.
- **Token:** access token `Authorization: Bearer ...`; muddati tugasa `POST /auth/refresh` (har safar yangi refresh token, eskisi bekor).
- **Belgilar:** 🆕 YANGI — 2026-10-10 (PT SDK 6.11.1) qo'shilgan; ♻️ O'ZGARGAN — shu sanada maydonlari kengaygan.


## 2026-10-10 dagi yangiliklar (PT SDK 6.11.1)

| Endpoint | Holat | Qisqacha |
|---|---|---|
| `POST /api/ingest/device-events` | 🆕 | SDK xom hodisalari (EV_*), (seq, sana) bo'yicha idempotent; EV_MEMS_* → Safety |
| `GET /api/mobile/device-config` | 🆕 | Qurilmaga yoziladigan `systemVars` + `configVersion` |
| `POST /api/ingest/telemetry` | ♻️ | lat/lon ixtiyoriy, yangi VDB maydonlari, DTC shina formatlari, `milOn`, `vin` |
| `POST /api/ingest/device-status` | ♻️ | TrackerInfo maydonlari; javobda `model`, `vinMismatch`, `systemVars`, `configVersion` |
| `POST /api/ingest/ble-state` | ♻️ | `connectionType` BLE \| USB |


## Mundarija

- [Health (tizim holati)](#bolim-health) — 1 ta
  - `GET /health/live` — Jarayon tirikligini tekshiradi (liveness). Process ishlab tursa doim javob beradi.
- [Autentifikatsiya](#bolim-auth) — 7 ta
  - `POST /api/auth/login/driver` — Haydovchi username + parol bilan ilovaga kiradi; access + refresh token qaytaradi.
  - `POST /api/auth/refresh` — Refresh token'ni almashtiradi (har ishlatilganda yangisi beriladi, eskisi bekor bo'ladi).
  - `POST /api/auth/logout` — Berilgan refresh token sessiyasini bekor qiladi (chiqish).
  - `POST /api/auth/password/forgot` — Parolni tiklash tokenini so'raydi. Doim 200 (foydalanuvchi bor-yo'qligi oshkor qilinmaydi).
  - `POST /api/auth/driver/password/forgot` — Haydovchi username yoki email bo'yicha parol tiklash kodini so'raydi. Doim 200; email bo'lsa kod yuboriladi.
  - `POST /api/auth/driver/password/reset` — Emaildagi kod bilan haydovchi parolini tiklaydi; haydovchining barcha sessiyalari bekor qilinadi.
  - `GET /api/auth/me` — Joriy autentifikatsiyalangan subyekt (token claim'lari) + web topbar maydonlari.
- [Biriktirmalar](#bolim-attachments) — 1 ta
  - `GET /api/attachments/{id}/presign` — Bitta biriktirma (rasm/fayl) uchun 15 daqiqalik presigned GET URL; DVIR/defekt/tiket bo'yicha ruxsat tekshiril
- [Mobil ilova (/mobile)](#bolim-mobile) — 51 ta
  - `POST /api/mobile/transfers` — Haydovchi o'z RODS'i uchun eRODS transfer boshlaydi: Appendix A fayl yaratiladi, tekshiriladi, saqlanadi, yubo
  - `GET /api/mobile/transfers` — Haydovchining oxirgi transferlari (S-10 / M-27 "Last transfer" kvitansiyalari).
  - `GET /api/mobile/app-config` — Ommaviy (auth'siz) ilova sozlamasi: min/oxirgi versiya, store va legal URL'lar, PT30 firmware. `appVersion` be
  - `GET /api/mobile/legal/{kind}` — Maxfiylik siyosati / foydalanish shartlari havolasi (`url`ni oching).
  - `GET /api/mobile/ping` — Tarmoq tezligi testi uchun `bytes` ta tasodifiy bayt (max 1 MiB). 30 so'rov/daqiqa. Konvertsiz.
  - `GET /api/mobile/bootstrap` — Ilova ochilganda: haydovchi, unit, qurilma, carrier konteksti, joriy HOS holati, engine versiyasi, server vaqt
  - `POST /api/mobile/sync` — Offline navbatdagi o'zgarishlarni bitta batch'da qo'llaydi: duty_status, log_entry, certify, dvir.
  - `POST /api/mobile/duty-status` — Haydovchi duty statusini o'zgartiradi (OFF/SB/ON). Offline'da /mobile/sync orqali navbatga qo'yiladi.
  - `POST /api/mobile/signature` — Imzo/rasm baytlarini storage'ga yuklaydi; /mobile/dvir yoki /mobile/certify da ishlatiladigan id qaytaradi.
  - `POST /api/mobile/dvir` — DVIR topshirish: inspeksiya, defektlar, haydovchi imzosi (+ ixtiyoriy mexanik ismi/imzosi).
  - `GET /api/mobile/available-vehicles` — M-03: haydovchi tanlashi mumkin bo'lgan unitlar (o'ziniki yoki boshqa faol haydovchi band qilmagan ACTIVE unit
  - `POST /api/mobile/release-vehicle` — Haydovchining unitini bo'shatadi, boshqa haydovchilar uni `available-vehicles` da ko'radi.
  - `POST /api/mobile/select-vehicle` — M-03: unitni haydovchiga biriktiradi.
  - `GET /api/mobile/co-driver` — Faol co-driver juftligi (ikkala o'rindiq), sherik ma'lumoti va faol trip hujjatlari/treylerlari; juftlik yo'q 
  - `POST /api/mobile/co-driver/switch` — Haydovchi o'rindig'ini co-driver'ga beradi; co-driver'ning o'z token juftligini qaytaradi.
  - `POST /api/mobile/co-driver/leave` — Co-driver juftligini tugatadi va chiqayotgan haydovchining unitini bo'shatadi.
  - `GET /api/mobile/trip` — Faol trip (IN_PROGRESS, bo'lmasa keyingi ASSIGNED): stops[] va documents[]; trip yo'q bo'lsa kun tafsilotlari.
  - `PATCH /api/mobile/trip` — Faol tripning haydovchi tahrirlay oladigan maydonlarini yangilaydi; trip yo'q bo'lsa kun tafsilotlari.
  - `GET /api/mobile/trailers` — Carrier'ning faol treylerlari; `q` raqam yoki VIN bo'yicha qidiradi.
  - `GET /api/mobile/dvirs` — M-10: haydovchining DVIR tarixi (defektlar soni, holat, ta'mir statusi).
  - `GET /api/mobile/dvirs/{id}` — M-11: DVIR tafsiloti — defektlar, rasmlar, haydovchi va mexanik imzolari.
  - `GET /api/mobile/dvirs/{id}/pdf` — M-11: DVIR PDF eksporti. Hozircha 501 qaytaradi (generator yo'q).
  - `GET /api/mobile/defect-catalog` — DVIR defekt katalogi (FMCSA 49 CFR 396.11 truck/trailer bandlari).
  - `GET /api/mobile/saved-signature` — Haydovchining saqlangan imzosi (15 daqiqalik URL) yoki `null`.
  - `PUT /api/mobile/saved-signature` — Haydovchi imzosini saqlaydi/almashtiradi (base64 yoki mavjud `signatureImageId`).
  - `DELETE /api/mobile/saved-signature` — Saqlangan imzoni unutadi (idempotent).
  - `GET /api/mobile/contacts` — Xabar yozish mumkin bo'lgan kontaktlar: ADMIN/FLEET_MANAGER/DISPATCHER, faol co-driver va support.
  - `POST /api/mobile/push-tokens` — Qurilmaning FCM tokenini ro'yxatdan o'tkazadi/yangilaydi (token bo'yicha upsert).
  - `DELETE /api/mobile/push-tokens/{token}` — Shu qurilmaning push tokenini o'chiradi (faqat chaqiruvchi haydovchiniki bo'lsa).
  - `GET /api/mobile/device-health` — Unitning faol malfunction/diagnostic kodlari, qurilma holati, kutilayotgan unidentified segmentlar va oxirgi H
  - `GET /api/mobile/conversations` — Haydovchi suhbatlari: oxirgi xabar va o'qilmaganlar soni.
  - `POST /api/mobile/conversations` — `GET /mobile/contacts` dagi kontakt bilan suhbat boshlaydi (yoki mavjudini ishlatadi) va birinchi xabarni yubo
  - `GET /api/mobile/conversations/{id}/messages` — Suhbat tarixi, cursor pagination.
  - `POST /api/mobile/conversations/{id}/messages` — Suhbatga xabar yuboradi (realtime `message.new`). `clientId` bo'yicha idempotent.
  - `POST /api/mobile/conversations/{id}/read` — Suhbatni o'qilgan qiladi.
  - `GET /api/mobile/maintenance` — Tanlangan unitning texnik xizmat vazifalari (eng kechikkani birinchi).
  - `GET /api/mobile/maintenance/{id}` — Bitta texnik xizmat vazifasi, yuborilgan invoice va tekshiruvchi izohi bilan.
  - `POST /api/mobile/maintenance/{id}/submit` — Texnik xizmat invoice'ini back-office tekshiruviga yuboradi.
  - `POST /api/mobile/device/mac` — Tanlangan unitga bog'langan ELD'ning ko'rilgan BLE MAC manzilini xabar qiladi (mos kelmasa alert).
  - `GET /api/mobile/device-config` 🆕 — 🆕 PT SDK 6.11: ulangan ELD uchun qurilmaga `SetSystemVar` bilan yoziladigan sozlamalar (`systemVars`) va `conf
  - `POST /api/mobile/log-entries` — Haydovchining o'z log tuzatishi (recordOrigin = 2, darhol faol). 4–60 belgilik izoh majburiy, sertifikat bekor
  - `POST /api/mobile/certify` — Ilovadan RODS kunlarini sertifikatlaydi; offline navbatga qo'yiladi.
  - `GET /api/mobile/log-edit-requests` — Haydovchini kutayotgan carrier tahrir takliflari.
  - `GET /api/mobile/certification-status` — Oxirgi `days` kunning (default 8, max 14) sertifikatsiya holati.
  - `GET /api/mobile/logs` — Haydovchining o'z RODS kuni (grafik, yozuvlar, sertifikatsiya).
  - `GET /api/mobile/logs/{date}/export` — Haydovchining bitta RODS kunini yuklab beradi: `format=csv` ishlaydi, `pdf` → 501.
  - `POST /api/mobile/hos-state` — Mobil engine hisoblagan HOS holatini qabul qiladi, saqlaydi va server bilan solishtiradi (drift).
  - `POST /api/mobile/feedback` — Haydovchi ilovasidan fikr-mulohaza yuboradi.
  - `POST /api/mobile/support/tickets` — Ilovadan support tiketi ochadi ("Send diagnostics to support" ham shu, category: diagnostics). Ixtiyoriy `cont
  - `GET /api/mobile/support/tickets` — Haydovchining o'z support tiketlari.
  - `GET /api/mobile/support/tickets/{id}` — Haydovchining bitta tiketi (boshqasiniki → 404).
- [Bildirishnomalar](#bolim-notifications) — 3 ta
  - `GET /api/notifications` ♻️ — Chaqiruvchining in-app bildirishnomalari, segment sonlari bilan. 🆕 yangi tur: `alert.device_vin_mismatch`.
  - `POST /api/notifications/read-all` — Barcha o'qilmagan bildirishnomalarni o'qilgan qiladi.
  - `POST /api/notifications/{id}/read` — Bitta bildirishnomani o'qilgan qiladi.
- [RODS loglar](#bolim-logs) — 2 ta
  - `POST /api/logs/edit-requests/{id}/accept` — Haydovchi carrier tahririni qabul qiladi (§395.30): taklif faol yozuvga aylanadi, asl yozuv "Inactive — Change
  - `POST /api/logs/edit-requests/{id}/reject` — Haydovchi carrier tahririni rad etadi (§395.30): so'rov yopiladi, log o'zgarmaydi.
- [Ingest (ELD → server)](#bolim-ingest) — 5 ta
  - `POST /api/ingest/events` — Ilova hisoblagan §395 Appendix A hodisalarini batch'da yuklaydi (max 500 ta / 1 MB, bitta tranzaksiya). `uuid`
  - `POST /api/ingest/telemetry` ♻️ — 🆕 Virtual Dashboard nuqtalarini yuklaydi (1 nuqta/60 s). SDK 6.11: lat/lon ixtiyoriy (GPS'siz nuqta), loadPct 
  - `POST /api/ingest/device-events` 🆕 — 🆕 PT SDK xom TelemetryEvent'larini yuklaydi (EV_POWER/IGNITION/ENGINE/TRIP/PERIODIC/BLE/BUS/MEMS; live + store
  - `POST /api/ingest/ble-state` ♻️ — BLE holati o'zgarishini xabar qiladi: CONNECTED / OUT_OF_RANGE / DISCONNECTED. 🆕 ixtiyoriy `connectionType` BL
  - `POST /api/ingest/device-status` ♻️ — 🆕 Stored hodisalar soni, firmware va SDK TrackerInfo (productName, bleFirmware, imei, reportedVin, connectionT
- [Unidentified driving](#bolim-unidentified) — 2 ta
  - `POST /api/unidentified/{id}/confirm` — Haydovchi "bu siz edingizmi?" savoliga javob beradi (§7.4). Qabul qilinsa yozuvlar unga biriktiriladi (recordO
  - `GET /api/unidentified/confirmation-requests` — Carrier shu haydovchidan tasdiqlashni so'ragan unidentified segmentlar (PENDING_CONFIRMATION).

<a id="bolim-health"></a>

## Health (tizim holati)

### `GET /health/live`

**Nima qiladi:** Jarayon tirikligini tekshiradi (liveness). Process ishlab tursa doim javob beradi.

- **Auth:** Ochiq (token kerak emas)
- **operationId:** `HealthController_live` · original: _Liveness probe — answers as long as the process is up (TZ §22.5)._

**Javob `200`:** Process is running.

```json
{
  "status": "ok"
}
```

**Xatolar:** `503` SERVICE_UNAVAILABLE — Process is shutting down.

---

<a id="bolim-auth"></a>

## Autentifikatsiya

### `POST /api/auth/login/driver`

**Nima qiladi:** Haydovchi username + parol bilan ilovaga kiradi; access + refresh token qaytaradi.

- **Auth:** Ochiq (token kerak emas)
- **Ekran:** `{'id': 'web/sign-in', 'title': 'Sign in', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.3'}`
- **operationId:** `AuthController_loginDriver` · original: _Driver password login (TZ §6.1)._
- **Izoh (backend):** D-130 — when the driver already has an assigned unit, the server writes the §395 Appendix A 4.5.1.5 login record (eventType 5, code 1) on it (idempotent).

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `username` | string | ha | ≥ 1 belgi |  |
| `password` | string | ha | ≥ 1 belgi |  |

**Javob `201`:** MB-9 — `driverId` is additive so the mobile app can name its per-driver offline DB file.

```json
{
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "a1b2...",
    "tokenType": "Bearer",
    "driverId": "drv_1"
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` INVALID_CREDENTIALS — Username or password is incorrect. · `422` VALIDATION_FAILED — Request validation failed. · `429` RATE_LIMITED — Too many requests — try again later.

---

### `POST /api/auth/refresh`

**Nima qiladi:** Refresh token'ni almashtiradi (har ishlatilganda yangisi beriladi, eskisi bekor bo'ladi).

- **Auth:** Ochiq (token kerak emas)
- **Ekran:** `{'id': 'web/sign-in', 'title': 'Sign in', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.3'}`
- **operationId:** `AuthController_refresh` · original: _Rotates a refresh token (TZ §6.5 — rotated on every use)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `refreshToken` | string | ha | ≥ 1 belgi |  |
| `subjectType` | `user` \| `driver` | ha |  |  |

**Javob `201`:** Created.

```json
{
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "a1b2...",
    "tokenType": "Bearer"
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` REFRESH_TOKEN_REUSED — This refresh token was already rotated — the whole session family is revoked (TZ §6.5). · `422` VALIDATION_FAILED — Request validation failed. · `429` RATE_LIMITED — Refresh is limited to 30 requests per minute per IP.

---

### `POST /api/auth/logout`

**Nima qiladi:** Berilgan refresh token sessiyasini bekor qiladi (chiqish).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/sign-in', 'title': 'Sign in', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.3'}`
- **operationId:** `AuthController_logout` · original: _Revokes the session behind the given refresh token._
- **Izoh (backend):** D-130 — for a driver it also writes the §395 Appendix A 4.5.1.5 logout record (eventType 5, code 2) for the open ELD login, if any.

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `refreshToken` | string | ha | ≥ 1 belgi |  |

**Javob `200`:** 

```json
{
  "success": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/auth/password/forgot`

**Nima qiladi:** Parolni tiklash tokenini so'raydi. Doim 200 (foydalanuvchi bor-yo'qligi oshkor qilinmaydi).

- **Auth:** Ochiq (token kerak emas)
- **Ekran:** `{'id': 'web/sign-in', 'title': 'Sign in', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.3'}`
- **operationId:** `AuthController_forgotPassword` · original: _Requests a password reset token. Always 200 (no user enumeration)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `email` | string (email) | ha |  |  |

**Javob `200`:** 

```json
{
  "success": true
}
```

**Xatolar:** `422` VALIDATION_FAILED — Request validation failed. · `429` RATE_LIMITED — Too many requests — try again later.

---

### `POST /api/auth/driver/password/forgot`

**Nima qiladi:** Haydovchi username yoki email bo'yicha parol tiklash kodini so'raydi. Doim 200; email bo'lsa kod yuboriladi.

- **Auth:** Ochiq (token kerak emas)
- **Ekran:** `{'id': 'web/sign-in', 'title': 'Sign in', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.3'}`
- **operationId:** `AuthController_forgotDriverPassword` · original: _MR-31 — driver requests a password-reset code by username or email. Always 200 (no user enumeration); the code is emailed when the driver has an email on file._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `username` | string | yo'q | 1–120 belgi |  |
| `email` | string (email) | yo'q |  |  |

So'rov misoli:

```json
{
  "username": "johnsmith"
}
```

**Javob `200`:** 

```json
{
  "success": true
}
```

**Xatolar:** `422` VALIDATION_FAILED — Request validation failed. · `429` RATE_LIMITED — Limited to 5 requests per minute per IP.

---

### `POST /api/auth/driver/password/reset`

**Nima qiladi:** Emaildagi kod bilan haydovchi parolini tiklaydi; haydovchining barcha sessiyalari bekor qilinadi.

- **Auth:** Ochiq (token kerak emas)
- **Ekran:** `{'id': 'web/sign-in', 'title': 'Sign in', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.3'}`
- **operationId:** `AuthController_resetDriverPassword` · original: _MR-31 — completes a driver password reset with the emailed code; revokes all driver sessions._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `token` | string | ha | ≥ 1 belgi |  |
| `newPassword` | string | ha | ≥ 8 belgi |  |

So'rov misoli:

```json
{
  "token": "eyJ...",
  "newPassword": "NewPassw0rd!"
}
```

**Javob `200`:** 

```json
{
  "success": true
}
```

**Xatolar:** `401` TOKEN_INVALID — The code is invalid, already used or expired. · `422` VALIDATION_FAILED — Request validation failed. · `429` RATE_LIMITED — Too many requests — try again later.

---

### `GET /api/auth/me`

**Nima qiladi:** Joriy autentifikatsiyalangan subyekt (token claim'lari) + web topbar maydonlari.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/my-profile', 'title': 'My profile · Active sessions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.4'}`
- **operationId:** `AuthController_me` · original: _The authenticated principal (TZ §6.3 token claims), plus B-34 topbar fields for a `user` subject._
- **Izoh (backend):** A `driver` subject additionally gets `username` (the ELD username, Appendix A 7.38), `fullName`, `email`, `homeTerminalTimezone`.

**Javob `200`:** Example: a driver subject. A user subject instead carries `role`, `permissions`, `sessionId`, `fullName`, `email`, `avatarUrl`, `carrierName`, `homeTerminalTimezone`.

```json
{
  "data": {
    "id": "drv_1",
    "type": "driver",
    "username": "johnsmith",
    "fullName": "John Smith",
    "email": "john@example.com",
    "homeTerminalTimezone": "America/New_York"
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-attachments"></a>

## Biriktirmalar

### `GET /api/attachments/{id}/presign`

**Nima qiladi:** Bitta biriktirma (rasm/fayl) uchun 15 daqiqalik presigned GET URL; DVIR/defekt/tiket bo'yicha ruxsat tekshiriladi.

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `AttachmentsController_presign` · original: _Short-lived (15 min) presigned GET URL for one attachment, permission-checked against its owning DVIR/defect/ticket._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "url": "https://minio.internal/onebook/dvir/photo.jpg?X-Amz-Signature=...",
  "expiresAt": "2026-09-24T15:56:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` ATTACHMENT_NOT_FOUND — Attachment not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-mobile"></a>

## Mobil ilova (/mobile)

### `POST /api/mobile/transfers`

**Nima qiladi:** Haydovchi o'z RODS'i uchun eRODS transfer boshlaydi: Appendix A fayl yaratiladi, tekshiriladi, saqlanadi, yuborish navbatga qo'yiladi. TEST rejimda yuborilmaydi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileTransfersController_create` · original: _Driver-initiated eRODS transfer of the driver's own RODS: generates and validates the §395 Appendix A file, stores it, queues the send. TEST mode never sends to FMCSA (status TEST_ONLY)._
- **Izoh (backend):** The row is returned as it stands right after generation (`status = QUEUED`); the worker moves it to TEST_ONLY / SENT / ACCEPTED / REJECTED / FAILED and fills `referenceId` + `sentAt`. Poll `GET /mobile/transfers` for the receipt (S-10).

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `method` | `WEB_SERVICES` \| `EMAIL` | ha |  |  |
| `rangeStart` | string (date-time) | ha |  |  |
| `rangeEnd` | string (date-time) | ha |  |  |
| `outputFileComment` | string | yo'q | ≤ 60 belgi, default `""` |  |
| `recipient` | string | yo'q | ≤ 254 belgi |  |

**Javob `201`:** Created.

```json
{
  "data": {
    "id": "trf_1",
    "method": "WEB_SERVICES",
    "status": "QUEUED",
    "erodsMode": "TEST",
    "referenceId": null,
    "sentAt": null,
    "createdAt": "2026-09-10T15:44:02.000Z",
    "fileName": "SMITH38018.csv",
    "outputFileComment": "ROADSIDE INSPECTION 2026-09-10",
    "rangeStart": "2026-09-03T00:00:00.000Z",
    "rangeEnd": "2026-09-10T00:00:00.000Z",
    "warnings": [
      "ERODS_TEST_MODE"
    ],
    "counts": {
      "header": 9,
      "events": 42
    }
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Driver token required (DRIVER_CONTEXT_REQUIRED). · `404` DRIVER_NOT_FOUND — Driver not found. · `422` OUTPUT_FILE_INVALID — The generated output file does not conform to §395 Appendix A and was not stored.

---

### `GET /api/mobile/transfers`

**Nima qiladi:** Haydovchining oxirgi transferlari (S-10 / M-27 "Last transfer" kvitansiyalari).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileTransfersController_list` · original: _The driver's own most recent transfers (receipts for S-10 / M-27 `Last transfer`)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `limit` | query | integer | yo'q | 1–50, default `5` |  |

**Javob `200`:** OK.

```json
{
  "data": {
    "items": [
      {
        "id": "trf_1",
        "method": "WEB_SERVICES",
        "status": "TEST_ONLY",
        "erodsMode": "TEST",
        "referenceId": "ERODS-TEST-26-0910-4821",
        "sentAt": "2026-09-10T15:44:02.000Z",
        "createdAt": "2026-09-10T15:44:00.000Z",
        "fileName": "SMITH38018.csv",
        "outputFileComment": "ROADSIDE INSPECTION 2026-09-10",
        "rangeStart": "2026-09-03T00:00:00.000Z",
        "rangeEnd": "2026-09-10T00:00:00.000Z"
      }
    ],
    "total": 1,
    "limit": 5
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Driver token required (DRIVER_CONTEXT_REQUIRED). · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/app-config`

**Nima qiladi:** Ommaviy (auth'siz) ilova sozlamasi: min/oxirgi versiya, store va legal URL'lar, PT30 firmware. `appVersion` berilsa `updateRequired` hisoblanadi.

- **Auth:** Ochiq (token kerak emas)
- **operationId:** `MobileAppConfigController_appConfig` · original: _MR-7 — public (no auth) app config: min/latest version, store + legal URLs, PT30 firmware. Unset values are null; `updateRequired` is computed when `appVersion` is sent._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `platform` | query | `android` \| `ios` | yo'q |  |  |
| `appVersion` | query | string | yo'q |  |  |

**Javob `200`:** OK.

```json
{
  "data": {
    "minSupportedVersion": "1.0.0",
    "latestVersion": "1.0.3",
    "storeUrl": "https://play.google.com/store/apps/details?id=com.onebook.eld_mobile",
    "userManualUrl": null,
    "privacyPolicyUrl": "https://onebook.example/privacy",
    "termsUrl": null,
    "minPt30Firmware": null,
    "recommendedPt30Firmware": null,
    "updateRequired": false,
    "updateAvailable": true
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `422` VALIDATION_FAILED — Request validation failed. · `429` RATE_LIMITED — 60 requests per minute per IP.

---

### `GET /api/mobile/legal/{kind}`

**Nima qiladi:** Maxfiylik siyosati / foydalanish shartlari havolasi (`url`ni oching).

- **Auth:** Ochiq (token kerak emas)
- **operationId:** `MobileAppConfigController_legal` · original: _MR-30 — privacy policy / terms pointer. `html` is always null (open `url`)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `kind` | path | `privacy` \| `terms` | ha |  |  |

**Javob `200`:** OK.

```json
{
  "data": {
    "version": "2026-10",
    "url": "https://onebook.example/privacy",
    "html": null
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `400` VALIDATION_FAILED — kind must be privacy or terms. · `422` VALIDATION_FAILED — Request validation failed. · `429` RATE_LIMITED — Too many requests — try again later.

---

### `GET /api/mobile/ping`

**Nima qiladi:** Tarmoq tezligi testi uchun `bytes` ta tasodifiy bayt (max 1 MiB). 30 so'rov/daqiqa. Konvertsiz.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileAppConfigController_ping` · original: _MR-29 — network speed-test payload: `bytes` random bytes (default 0, capped at 1048576 = 1 MiB). Driver token, 30 requests/min. Not enveloped._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `bytes` | query | any | yo'q |  |  |

**Javob `200`:** application/octet-stream body of the requested size.

```json
"<65536 random bytes>"
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/bootstrap`

**Nima qiladi:** Ilova ochilganda: haydovchi, unit, qurilma, carrier konteksti, joriy HOS holati, engine versiyasi, server vaqti va offline DOT inspeksiya paketi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileBootstrapController_get` · original: _Driver/vehicle/device/carrier context, current HOS state, the engine version, server time and the offline DOT-inspection packet (§8.6, §13.2, §13.5)._

**Javob `200`:** `inspectionPacket.days[]` has the `GET /mobile/logs` day shape (8 days, oldest first; shown empty here for brevity).

```json
{
  "data": {
    "serverTime": "2026-10-08T15:41:00.000Z",
    "hosEngineVersion": "1.0.3",
    "driver": {
      "id": "drv_1",
      "username": "johnsmith",
      "firstName": "John",
      "lastName": "Smith",
      "cdlNumber": "W8569238",
      "cdlState": "KY",
      "email": "john@example.com",
      "phone": "+15025550100",
      "exemptDriverStatus": false,
      "status": "ACTIVE",
      "homeTerminalName": "Columbus Terminal",
      "homeTerminalTimezone": "America/New_York",
      "hosRuleset": "US_70_8_PROPERTY",
      "exceptions": {
        "allowPersonalConveyance": true,
        "allowYardMove": true,
        "adverseDrivingEnabled": false,
        "shortHaulException": false,
        "splitSleeperEnabled": true,
        "eldExempt": false,
        "eldExemptReason": null
      },
      "lastSyncAt": "2026-10-08T15:30:00.000Z"
    },
    "vehicle": {
      "id": "veh_1",
      "unitNumber": "4821",
      "vin": "1FUJA6CV71LM12345",
      "make": "Freightliner",
      "model": "Cascadia",
      "year": 2021,
      "sleeperBerth": true,
      "status": "ACTIVE",
      "odometerMi": 84213
    },
    "device": {
      "id": "dev_1",
      "serial": "PT30-001",
      "model": "PT30",
      "firmware": "2.4.1",
  …
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/mobile/sync`

**Nima qiladi:** Offline navbatdagi o'zgarishlarni bitta batch'da qo'llaydi: duty_status, log_entry, certify, dvir.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileSyncController_sync` · original: _Applies a batch of offline-queued changes (§13.4): duty_status, log_entry, certify, dvir._
- **Izoh (backend):** Per-change outcomes: every `clientId` lands in `accepted` or `rejected` (never dropped; replays idempotent).

`duty_status` / `log_entry` payloads accept `locationName` (5-60 chars, no lat/lon needed — MR-6), `specialCondition` PC|YM (MR-23, gated by driver exceptions) and `engineHours`.

MR-25 shared tablet — optional `driverId` on a change: applied to that driver only for `duty_status` / `log_entry`, and only if the two drivers shared one unit at `occurredAt` (a co-driver pairing on it, or both logged in to it per their ELD login records, eventType 5); otherwise that change alone is rejected with `SYNC_DELEGATION_NOT_ALLOWED`. Delegated changes are audited (`SYNC_DELEGATED_CHANGE`); certification and DVIR are never delegated.

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `lastSyncAt` | string (date-time) | yo'q |  |  |
| `hosEngineVersion` | string | yo'q | ≤ 20 belgi |  |
| `changes` | object[] | ha | ≤ 500 ta |  |
| `backlog` | object | yo'q |  |  |
| `backlog.days` | number | ha | 0–3650 |  |
| `backlog.bytes` | integer | ha | ≥ 0 |  |

**Javob `200`:** OK.

```json
{
  "data": {
    "accepted": [
      "uuid1"
    ],
    "rejected": [
      {
        "clientId": "uuid3",
        "code": "DRIVING_TIME_IMMUTABLE",
        "message": "Driving time can never be hand-entered."
      },
      {
        "clientId": "uuid4",
        "code": "SYNC_DELEGATION_NOT_ALLOWED"
      }
    ],
    "serverChanges": [
      {
        "id": "9102",
        "eventType": 1,
        "eventCode": 3,
        "eventDateTime": "2026-09-11T15:00:00.000Z",
        "recordStatus": 1,
        "recordOrigin": 1,
        "annotation": null,
        "supersedesId": null
      }
    ],
    "serverTime": "2026-09-11T15:41:00.000Z",
    "hosEngineVersion": "1.0.3",
    "nextSyncAfterSec": 60
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` SYNC_BATCH_TOO_LARGE — Batch exceeds 500 changes or 1 MB.

---

### `POST /api/mobile/duty-status`

**Nima qiladi:** Haydovchi duty statusini o'zgartiradi (OFF/SB/ON). Offline'da /mobile/sync orqali navbatga qo'yiladi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileDutyStatusController_change` · original: _Driver-initiated duty status change from the app (OFF/SB/ON). Works offline, queued via /mobile/sync._
- **Izoh (backend):** MR-6 — optional `locationName` (5-60 chars, §395 Appendix A manual location) is accepted WITHOUT lat/lon and is shown as the record location in `GET /mobile/logs` (`locationName` / `locationDescription`).

MR-23 — `specialCondition: "PC"` with `status: "OFF"` (personal conveyance) or `"YM"` with `status: "ON"` (yard move) appends an Appendix A eventType 3 record (code 1 / 2) next to the duty record. Allowed only when the driver's exception is enabled (`allowPersonalConveyance` / `allowYardMove`), else 422 SPECIAL_CONDITION_NOT_ALLOWED. A plain status while PC/YM is in force ends it (eventType 3 code 0). A PC position is stored at 10-mile precision.

MR-13 — when `odometerMi` / `engineHours` are omitted, the unit’s last recorded reading at or before `startAt` is stored.

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `date` | string | yo'q | pattern `^\d{4}-\d{2}-\d{2}$` |  |
| `status` | `OFF` \| `SB` \| `ON` | ha |  |  |
| `startAt` | string (date-time) | ha |  |  |
| `endAt` | string (date-time) | yo'q |  |  |
| `annotation` | string | yo'q | 4–60 belgi |  |
| `location` | object | yo'q |  |  |
| `location.lat` | number | ha | -90–90 |  |
| `location.lon` | number | ha | -180–180 |  |
| `location.name` | string | yo'q | ≤ 120 belgi |  |
| `locationName` | string | yo'q, null mumkin | 5–60 belgi |  |
| `odometerMi` | integer | yo'q | 0–9999999 |  |
| `engineHours` | number | yo'q, null mumkin | 0–99999 |  |
| `specialCondition` | `NONE` \| `PC` \| `YM` | yo'q, null mumkin |  |  |
| `originalEventId` | string | yo'q | pattern `^\d+$` |  |

**Javob `201`:** Created.

```json
{
  "data": {
    "id": "9101",
    "driverId": "drv_1",
    "status": "OFF",
    "specialCondition": "PC",
    "locationName": "Columbus, OH",
    "startAt": "2026-09-11T15:41:00.000Z",
    "endAt": null,
    "recordOrigin": 2,
    "recordStatus": 1,
    "applied": true,
    "recertificationRequired": true
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` 422 — one of: DRIVING_TIME_IMMUTABLE; SPECIAL_CONDITION_NOT_ALLOWED (details.exception); VALIDATION_FAILED (PC needs OFF, YM needs ON, `l…

---

### `POST /api/mobile/signature`

**Nima qiladi:** Imzo/rasm baytlarini storage'ga yuklaydi; /mobile/dvir yoki /mobile/certify da ishlatiladigan id qaytaradi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileDvirController_uploadSignature` · original: _Uploads captured signature/photo bytes to object storage; returns an id referenced by /mobile/dvir or /mobile/certify. purpose = DVIR_PHOTO also creates an Attachment row (attachmentId) to pass in defects[].photoAttachmentIds (MB-6). M-39: purpose = INVOICE accepts application/pdf (max 10 MiB, `%PDF-` header verified; PNG/JPEG 2 MB) and creates an Attachment (kind INVOICE) whose id is `invoiceAttachmentId` of POST /mobile/maintenance/:id/submit; the uploader reads it back with GET /attachments/:id/presign._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `purpose` | `CERTIFICATION` \| `DVIR` \| `DVIR_PHOTO` \| `INVOICE` | ha |  |  |
| `base64` | string | ha | ≥ 16 belgi |  |
| `mimeType` | `image/png` \| `image/jpeg` \| `application/pdf` | yo'q | default `"image/png"` |  |

**Javob `201`:** `attachmentId` is the Attachment id for purpose DVIR_PHOTO and INVOICE (equal to `signatureImageId`), null for signatures.

```json
{
  "data": {
    "signatureImageId": "9c2a0f4e-0000-4000-8000-000000000031",
    "attachmentId": "9c2a0f4e-0000-4000-8000-000000000031",
    "key": "invoices/drv_1/9c2a0f4e-0000-4000-8000-000000000031.pdf",
    "sha256": "a1b2...",
    "sizeBytes": 182044
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — The base64 payload decoded to zero bytes, application/pdf with a purpose other than INVOICE, or bytes without a %PDF-…

---

### `POST /api/mobile/dvir`

**Nima qiladi:** DVIR topshirish: inspeksiya, defektlar, haydovchi imzosi (+ ixtiyoriy mexanik ismi/imzosi).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileDvirController_submit` · original: _Driver DVIR submission: inspection, defects and the driver signature (+ optional mechanic name/signature)._
- **Izoh (backend):** MR-9: `defects[].category` should be a `code` from `GET /mobile/defect-catalog` (unknown values are still accepted and stored as sent). MR-10: optional `mechanicName`, `mechanicSignatureBase64`, `mechanicSignatureMimeType` (PNG/JPEG, 2 MB; a signature needs the name). MR-11: `odometerMi` is optional (falls back to the unit odometer when known). `clientId` makes a replay return the first answer (409 if spent on another operation). D-129: optional `trailerNumber` (free text, trimmed + upper-cased, 1-10 chars `[A-Z0-9-]`, Appendix A 7.42) is stored as typed and linked to an ACTIVE carrier trailer when it matches — never 422; an explicit `trailerId` must still exist.

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `vehicleId` | string (uuid) | ha |  |  |
| `trailerId` | string (uuid) | yo'q |  |  |
| `trailerNumber` | string | yo'q |  |  |
| `type` | `PRE_TRIP` \| `POST_TRIP` \| `INTERMEDIATE` | ha |  |  |
| `submittedAt` | string (date-time) | ha |  |  |
| `odometerMi` | integer | yo'q, null mumkin | 0–9999999 |  |
| `location` | object | yo'q |  |  |
| `location.lat` | number | ha | -90–90 |  |
| `location.lon` | number | ha | -180–180 |  |
| `location.name` | string | yo'q | ≤ 120 belgi |  |
| `vehicleCondition` | `SATISFACTORY` \| `DEFECTS_FOUND` | ha |  |  |
| `notes` | string | yo'q | ≤ 500 belgi |  |
| `defects` | object[] | yo'q | ≤ 50 ta, default `[]` |  |
| `defects[].part` | `TRUCK` \| `TRAILER` | ha |  |  |
| `defects[].category` | string | ha | 1–120 belgi |  |
| `defects[].severity` | `MINOR` \| `MAJOR` \| `CRITICAL` | ha |  |  |
| `defects[].description` | string | ha | 1–500 belgi |  |
| `defects[].photoAttachmentIds` | string (uuid)[] | yo'q | ≤ 10 ta, default `[]` |  |
| `signatureBase64` | string | ha | ≥ 16 belgi |  |
| `signatureMimeType` | `image/png` \| `image/jpeg` | yo'q | default `"image/png"` |  |
| `mechanicName` | string | yo'q, null mumkin | 1–120 belgi |  |
| `mechanicSignatureBase64` | string | yo'q, null mumkin | ≥ 16 belgi |  |
| `mechanicSignatureMimeType` | `image/png` \| `image/jpeg` | yo'q, null mumkin |  |  |
| `clientId` | string | yo'q, null mumkin | 8–64 belgi |  |

**Javob `201`:** Created.

```json
{
  "data": {
    "id": "dvir_1",
    "driverId": "drv_1",
    "vehicleId": "veh_1",
    "trailerId": null,
    "trailerNumber": "X53-1188",
    "type": "PRE_TRIP",
    "submittedAt": "2026-10-08T12:00:00.000Z",
    "vehicleCondition": "DEFECTS_FOUND",
    "defectCount": 1,
    "photoCount": 2,
    "outOfService": false,
    "signatureImageId": "sig_9c2a",
    "mechanicSignatureImageId": null,
    "applied": true
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `409` CONFLICT — clientId already used by another operation. · `422` TRAILER_NOT_FOUND — trailerId is unknown, or names a trailer deleted before this inspection.

---

### `GET /api/mobile/available-vehicles`

**Nima qiladi:** M-03: haydovchi tanlashi mumkin bo'lgan unitlar (o'ziniki yoki boshqa faol haydovchi band qilmagan ACTIVE unit).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileVehicleController_list` · original: _M-03 — units this driver may select: their own unit, or an ACTIVE unit no other ACTIVE driver currently holds._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `limit` | query | integer | yo'q | 1–200 | MR-32 — 1-200; absent = no cap. The body stays a plain array either way. |
| `q` | query | string | yo'q | ≤ 100 belgi | MR-32 — substring of unit number / VIN / make / model / device serial (case-insensitive). |

**Javob `200`:** OK.

```json
{
  "data": [
    {
      "id": "veh_1",
      "unitNumber": "104",
      "make": "Freightliner",
      "model": "Cascadia",
      "deviceSerial": "PT30-1004"
    }
  ],
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/mobile/release-vehicle`

**Nima qiladi:** Haydovchining unitini bo'shatadi, boshqa haydovchilar uni `available-vehicles` da ko'radi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileVehicleController_release` · original: _MR-2 — releases the calling driver's assigned unit so other drivers see it in `available-vehicles`._
- **Izoh (backend):** Clears `Driver.assignedVehicleId`. If the driver is in an active co-driver pairing ON THAT UNIT the pairing is ended too (`endedById` = caller). Idempotent on `clientId`: a replay returns the first `{released:true, vehicleId}` instead of 409. Note `POST /mobile/co-driver/leave` DOES clear the leaving driver's unit, but only when an active pairing exists; without a pairing it returns `{ended:false}` and the unit is NOT released — use this endpoint for that case.

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `clientId` | string (uuid) | yo'q, null mumkin |  |  |
| `reason` | string | yo'q, null mumkin | ≤ 200 belgi |  |

**Javob `200`:** OK.

```json
{
  "data": {
    "released": true,
    "vehicleId": "veh_1"
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `409` NO_ASSIGNED_VEHICLE — You have no assigned vehicle to release. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/mobile/select-vehicle`

**Nima qiladi:** M-03: unitni haydovchiga biriktiradi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileVehicleController_select` · original: _M-03 — assigns a unit to the calling driver (`Driver.assignedVehicleId`)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `vehicleId` | string (uuid) | ha |  |  |

**Javob `201`:** Created.

```json
{
  "data": {
    "id": "veh_1",
    "unitNumber": "104",
    "vin": "1FUJA6CV71LM12345",
    "make": "Freightliner",
    "model": "Cascadia",
    "year": 2021,
    "sleeperBerth": true,
    "status": "ACTIVE",
    "odometerMi": 84213,
    "device": {
      "id": "dev_1",
      "serial": "PT30-1004",
      "model": "PT30"
    }
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `409` CONFLICT — This unit is already assigned to another active driver. · `422` VEHICLE_OUT_OF_SERVICE — This unit is out of service and cannot be selected.

---

### `GET /api/mobile/co-driver`

**Nima qiladi:** Faol co-driver juftligi (ikkala o'rindiq), sherik ma'lumoti va faol trip hujjatlari/treylerlari; juftlik yo'q bo'lsa `null`.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileCoDriverController_current` · original: _MR-15 — the caller's active co-driver pairing (either seat) with the co-driver's identity and the active trip's documents/trailers; `null` when not paired._

**Javob `200`:** `data` is null when the caller is not paired; `trip` is absent when there is no active trip.

```json
{
  "data": {
    "pairingId": "pair_1",
    "startedAt": "2026-10-08T08:00:00.000Z",
    "coDriver": {
      "id": "drv_2",
      "firstName": "Jane",
      "lastName": "Doe",
      "username": "jdoe"
    },
    "trip": {
      "shippingDocuments": [
        "BOL-2201"
      ],
      "trailerNumbers": [
        "TR-1"
      ]
    }
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/mobile/co-driver/switch`

**Nima qiladi:** Haydovchi o'rindig'ini co-driver'ga beradi; co-driver'ning o'z token juftligini qaytaradi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileCoDriverController_switch` · original: _S-11/S-18/S-19 — hands the driver seat to the paired co-driver; returns the CO-DRIVER's own token pair._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `coDriverPassword` | string | ha | 1–200 belgi |  |

**Javob `201`:** Created.

```json
{
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "a1b2...",
    "tokenType": "Bearer"
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — No active co-driver pairing for this driver. · `422` CO_DRIVER_PASSWORD_INVALID — The co-driver password is incorrect.

---

### `POST /api/mobile/co-driver/leave`

**Nima qiladi:** Co-driver juftligini tugatadi va chiqayotgan haydovchining unitini bo'shatadi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileCoDriverController_leave` · original: _S-19 — ends the active co-driver pairing and clears the leaving driver's assigned unit._
- **Izoh (backend):** Without an active pairing it is a no-op returning `{ended:false}` and the unit is NOT released; use `POST /mobile/release-vehicle` for that (MR-2).

**Javob `201`:** Created.

```json
{
  "data": {
    "ended": true
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/trip`

**Nima qiladi:** Faol trip (IN_PROGRESS, bo'lmasa keyingi ASSIGNED): stops[] va documents[]; trip yo'q bo'lsa kun tafsilotlari.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileTripController_get` · original: _M-05/S-05/P-03 — active (IN_PROGRESS, else next ASSIGNED) trip with stops[] and documents[]; with no trip, the day details (D-129)._
- **Izoh (backend):** With an active trip the body is the trip (`source:"TRIP"`). With NO active trip (D-129, M-09/M-12) the body is the driver's day details for `date` (home-terminal RODS day, default today): `source:"DAY_DETAILS"`, `id:null`, `trip:null`, `logDate`, the same `shippingDocument(s)` / `trailerNumber(s)` / `trailerId` / `bobtail` / `notes` fields, `stops:[]`, `documents[]`. Never null any more — empty lists when nothing is stored.

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `date` | query | string | yo'q | pattern `^\d{4}-\d{2}-\d{2}$` | YYYY-MM-DD home-terminal day; only used when there is no active trip. |

**Javob `200`:** `data` is one of two shapes, told apart by `source`: `TRIP` (the trip) or `DAY_DETAILS` (no active trip). Example shows `DAY_DETAILS`; see PATCH for `TRIP`.

```json
{
  "data": {
    "source": "DAY_DETAILS",
    "id": null,
    "trip": null,
    "logDate": "2026-10-08",
    "shippingDocument": "BOL-2201",
    "shippingDocuments": [
      "BOL-2201"
    ],
    "trailerId": null,
    "trailerNumber": "X53-1188",
    "trailerNumbers": [
      "X53-1188"
    ],
    "bobtail": false,
    "notes": null,
    "updatedAt": "2026-10-08T14:02:11.000Z",
    "stops": [],
    "documents": []
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/mobile/trip`

**Nima qiladi:** Faol tripning haydovchi tahrirlay oladigan maydonlarini yangilaydi; trip yo'q bo'lsa kun tafsilotlari.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileTripController_patch` · original: _P-03 — updates the driver-editable fields of the active trip; with no trip, the day details (D-129)._
- **Izoh (backend):** MR-4. `shippingDocument`, `trailerNumber` and `notes` accept `null` or `""` to CLEAR the value. `trailerNumber:"BOBTAIL"` (case-insensitive) or `bobtail:true` means "no trailer" (200, trailerId cleared; combining it with a real trailer is 422). Optional arrays `shippingDocuments: string[]` / `trailerNumbers: string[]` (max 20) replace the lists and win over the single fields; the single fields mirror the first element. The response always carries `shippingDocument(s)`, `trailerNumber(s)`, `bobtail`. D-129: trailer numbers are FREE TEXT (no 422 TRAILER_NOT_FOUND) — trimmed, upper-cased, each 1-10 chars `[A-Z0-9-]` and all of them joined by spaces at most 32 chars (49 CFR 395 Appendix A 7.42); `trailerId` links the first one matching an ACTIVE carrier trailer, else null. Shipping documents are at most 40 chars each (7.39). With NO active trip the fields are stored for the RODS day `logDate` (YYYY-MM-DD home-terminal day, default today, at most 30 days back) and the response is the day-details shape (`source:"DAY_DETAILS"`, `id:null`); a change on a certified day drops its certification (re-certification required).

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `shippingDocument` | string | yo'q, null mumkin | ≤ 40 belgi |  |
| `trailerNumber` | string | yo'q, null mumkin |  |  |
| `notes` | string | yo'q, null mumkin | ≤ 60 belgi |  |
| `bobtail` | boolean | yo'q |  |  |
| `shippingDocuments` | string[] | yo'q | ≤ 20 ta |  |
| `trailerNumbers` | string[] | yo'q | ≤ 20 ta |  |
| `logDate` | string | yo'q | pattern `^\d{4}-\d{2}-\d{2}$` |  |

**Javob `200`:** Same two shapes as GET (told apart by `source`). Example shows `TRIP`.

```json
{
  "data": {
    "source": "TRIP",
    "id": "trip_1",
    "number": "T-1042",
    "status": "IN_PROGRESS",
    "vehicleId": "veh_1",
    "trailerId": "trl_1",
    "shippingDocument": "BOL-2201",
    "shippingDocuments": [
      "BOL-2201",
      "BOL-2202"
    ],
    "trailerNumber": "TR-1",
    "trailerNumbers": [
      "TR-1",
      "X53-1188"
    ],
    "bobtail": false,
    "commodity": "Produce",
    "weightLbs": 38000,
    "pieces": 22,
    "plannedStartAt": "2026-10-08T12:00:00.000Z",
    "plannedEndAt": "2026-10-09T02:00:00.000Z",
    "startedAt": "2026-10-08T12:10:00.000Z",
    "completedAt": null,
    "etaAt": "2026-10-09T01:30:00.000Z",
    "onTime": true,
    "notes": "Left the yard early",
    "stops": [
      {
        "id": "stp_1",
        "sequence": 1,
        "type": "PICKUP",
        "name": "Shipper #4821",
        "address": "100 Dock Rd, Columbus, OH",
        "latitude": 39.96,
        "longitude": -82.99,
        "scheduledAt": "2026-10-08T12:00:00.000Z",
        "arrivedAt": "2026-10-08T12:05:00.000Z",
        "departedAt": null,
        "status": "ARRIVED",
        "note": null
      }
    ],
  …
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Bad trailer number format, BOBTAIL mixed with a trailer, or logDate out of range.

---

### `GET /api/mobile/trailers`

**Nima qiladi:** Carrier'ning faol treylerlari; `q` raqam yoki VIN bo'yicha qidiradi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileTrailersController_list` · original: _P-03 — the carrier's active (not deleted) trailers; `q` matches number or VIN, case-insensitive._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `limit` | query | integer | yo'q | 1–200 | 1-200, default 50. |
| `q` | query | string | yo'q | ≤ 100 belgi | Substring of the trailer number / VIN. |

**Javob `200`:** OK.

```json
{
  "data": [
    {
      "id": "trl_1",
      "number": "TR-1",
      "plate": null
    }
  ],
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/dvirs`

**Nima qiladi:** M-10: haydovchining DVIR tarixi (defektlar soni, holat, ta'mir statusi).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileDvirHistoryController_list` · original: _M-10 — own DVIR history: defect count, condition and repair-status summary per submission._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `days` | query | integer | yo'q | 1–90, default `14` |  |

**Javob `200`:** OK.

```json
{
  "data": [
    {
      "id": "dvir_1",
      "vehicleId": "veh_1",
      "type": "PRE_TRIP",
      "submittedAt": "2026-09-10T12:00:00.000Z",
      "vehicleCondition": "DEFECTS_FOUND",
      "defectCount": 1,
      "repairStatus": "PENDING",
      "trailerNumber": "X53-1188",
      "odometerMi": 84213
    }
  ],
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/dvirs/{id}`

**Nima qiladi:** M-11: DVIR tafsiloti — defektlar, rasmlar, haydovchi va mexanik imzolari.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileDvirHistoryController_get` · original: _M-11/P-07 — full DVIR detail: defects, photos, driver + mechanic signatures._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** OK.

```json
{
  "data": {
    "id": "dvir_1",
    "driverId": "drv_1",
    "vehicleId": "veh_1",
    "trailerId": null,
    "type": "PRE_TRIP",
    "submittedAt": "2026-09-10T12:00:00.000Z",
    "odometerMi": 84213,
    "location": {
      "lat": 39.96,
      "lon": -82.99,
      "name": "2mi ESE OH Columbus"
    },
    "trailerNumber": "X53-1188",
    "vehicleCondition": "DEFECTS_FOUND",
    "notes": null,
    "repairStatus": "PENDING",
    "driverSignature": {
      "key": "signatures/drv_1/sig_9c2a.png",
      "url": "https://...",
      "hash": "a1b2..."
    },
    "mechanicSignature": null,
    "nextDriverReviewedAt": null,
    "defects": [
      {
        "id": "def_1",
        "part": "TRUCK",
        "category": "BRAKES_SERVICE",
        "severity": "MAJOR",
        "description": "Air leak at the rear axle",
        "status": "OPEN",
        "outOfService": false,
        "resolvedAt": null,
        "resolutionNote": null,
        "photos": [
          {
            "id": "att_1",
            "url": "https://...",
            "mimeType": "image/jpeg",
            "sizeBytes": 120344
          }
        ]
      }
  …
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DVIR_NOT_FOUND — DVIR not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/dvirs/{id}/pdf`

**Nima qiladi:** M-11: DVIR PDF eksporti. Hozircha 501 qaytaradi (generator yo'q).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileDvirHistoryController_pdf` · original: _M-11 — per-DVIR PDF export. Not implemented yet: no single-DVIR PDF generator exists (see MobileDvirHistoryService) — every call answers 501 today; the 200 below documents the contract once a generator lands._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** Future state once a single-DVIR PDF generator exists — every call answers 501 today (see below).

```json
"%PDF-1.4 ..."
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DVIR_NOT_FOUND — DVIR not found. · `422` VALIDATION_FAILED — Request validation failed. · `501` NOT_IMPLEMENTED — A single-DVIR PDF export is not implemented yet.

---

### `GET /api/mobile/defect-catalog`

**Nima qiladi:** DVIR defekt katalogi (FMCSA 49 CFR 396.11 truck/trailer bandlari).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileCatalogController_defectCatalog` · original: _MR-9 — DVIR defect catalog (FMCSA 49 CFR 396.11 truck / trailer inspection items)._
- **Izoh (backend):** `code` is stable and unique per `part`; send it as `defects[].category` in `POST /mobile/dvir`. `critical` is a hint that a defect on this item is typically out-of-service class — the driver still picks the defect `severity`. Unknown categories are still accepted by the DVIR submit (lenient, for older app builds that send the English item name). M-29: the list is the design's (rows verbatim, in design order); `isPhoto` marks the "Accident Photo" row — a photo capture, not an inspection item.

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `part` | query | `TRUCK` \| `TRAILER` | yo'q |  | Omit to get both parts. |

**Javob `200`:** OK.

```json
{
  "data": [
    {
      "code": "ACCIDENT_PHOTO",
      "name": "Accident Photo",
      "part": "TRUCK",
      "category": "Accident",
      "critical": false,
      "isPhoto": true
    },
    {
      "code": "BRAKES_SERVICE",
      "name": "Brakes, Service",
      "part": "TRUCK",
      "category": "Brakes",
      "critical": true,
      "isPhoto": false
    }
  ],
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/saved-signature`

**Nima qiladi:** Haydovchining saqlangan imzosi (15 daqiqalik URL) yoki `null`.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileCatalogController_get` · original: _MR-27 — the driver's saved signature (presigned 15 min URL), or `null` when none is saved._

**Javob `200`:** `data` is null when no signature is saved.

```json
{
  "data": {
    "signatureImageId": "3f2c...",
    "key": "signatures/drv_1/3f2c.png",
    "url": "https://...",
    "mimeType": "image/png",
    "sizeBytes": 4821,
    "sha256": "a1b2...",
    "updatedAt": "2026-10-08T12:00:00.000Z"
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PUT /api/mobile/saved-signature`

**Nima qiladi:** Haydovchi imzosini saqlaydi/almashtiradi (base64 yoki mavjud `signatureImageId`).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileCatalogController_put` · original: _MR-27 — saves (replaces) the driver's signature: base64 bytes + mime, or an existing `signatureImageId` from `POST /mobile/signature`._
- **Izoh (backend):** Exactly one of `signatureBase64` / `signatureImageId`. PNG/JPEG, max 2 MB. Idempotent on `clientId` (409 when that id was spent on another operation).

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `signatureBase64` | string | yo'q, null mumkin | ≥ 16 belgi |  |
| `mimeType` | `image/png` \| `image/jpeg` | yo'q, null mumkin |  |  |
| `signatureImageId` | string | yo'q, null mumkin | pattern `^[A-Za-z0-9_-]{1,100}$` |  |
| `clientId` | string | yo'q, null mumkin | 8–64 belgi |  |

So'rov misoli:

```json
{
  "signatureBase64": "iVBORw0KGgo...",
  "mimeType": "image/png",
  "clientId": "7d1c2a40-0000-4000-8000-000000000001"
}
```

**Javob `200`:** OK.

```json
{
  "data": {
    "signatureImageId": "3f2c...",
    "key": "signatures/drv_1/3f2c.png",
    "url": "https://...",
    "mimeType": "image/png",
    "sizeBytes": 4821,
    "sha256": "a1b2...",
    "updatedAt": "2026-10-08T12:00:00.000Z"
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `409` CONFLICT — clientId already used by another operation. · `422` VALIDATION_FAILED — Neither/both of signatureBase64 and signatureImageId, an empty payload, or an unknown signatureImageId.

---

### `DELETE /api/mobile/saved-signature`

**Nima qiladi:** Saqlangan imzoni unutadi (idempotent).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileCatalogController_remove` · original: _MR-27 — forgets the saved signature (idempotent; the stored object is kept, earlier DVIRs may reference it)._

**Javob `200`:** `deleted: false` when nothing was saved.

```json
{
  "data": {
    "deleted": true
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/contacts`

**Nima qiladi:** Xabar yozish mumkin bo'lgan kontaktlar: ADMIN/FLEET_MANAGER/DISPATCHER, faol co-driver va support.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileContactsController_list` · original: _M-15/M-16 — ADMIN/FLEET_MANAGER/DISPATCHER staff, the active co-driver, and a synthetic support entry._

**Javob `200`:** OK.

```json
{
  "data": [
    {
      "id": "usr_1",
      "name": "Mike Torres",
      "role": "FLEET_MANAGER",
      "phone": "+1-555-0100"
    },
    {
      "id": "support",
      "name": "OneBook ELD Support",
      "role": "SUPPORT",
      "phone": null
    }
  ],
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/mobile/push-tokens`

**Nima qiladi:** Qurilmaning FCM tokenini ro'yxatdan o'tkazadi/yangilaydi (token bo'yicha upsert).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `PushTokensController_register` · original: _Registers/refreshes an FCM token for this driver's device (upsert by token; re-owned if it moved devices)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `token` | string | ha | 8–4096 belgi |  |
| `platform` | `IOS` \| `ANDROID` | ha |  |  |
| `deviceLabel` | string | yo'q | ≤ 200 belgi |  |

**Javob `201`:** Created.

```json
{
  "data": {
    "id": "pt_1",
    "driverId": "drv_1",
    "token": "fcm-token...",
    "platform": "IOS",
    "deviceLabel": "iPhone 15",
    "lastSeenAt": "2026-09-21T00:00:00.000Z",
    "createdAt": "2026-09-01T00:00:00.000Z"
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/mobile/push-tokens/{token}`

**Nima qiladi:** Shu qurilmaning push tokenini o'chiradi (faqat chaqiruvchi haydovchiniki bo'lsa).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `PushTokensController_remove` · original: _Deletes this device's push token — only if it belongs to the calling driver._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `token` | path | string | ha |  |  |

**Javob `200`:** OK.

```json
{
  "data": {
    "deleted": true
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Push token not found for this driver. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/device-health`

**Nima qiladi:** Unitning faol malfunction/diagnostic kodlari, qurilma holati, kutilayotgan unidentified segmentlar va oxirgi HOS drift (M-20/P-12).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `DeviceHealthController_get` · original: _Active malfunction/diagnostic codes, device status, pending unidentified segments and last HOS drift for the driver's assigned vehicle (M-20/P-12)._

**Javob `200`:** OK.

```json
{
  "data": {
    "vehicleId": "veh_1",
    "device": {
      "id": "dev_1",
      "serial": "PT30-001",
      "firmware": "2.4.1",
      "bleState": "CONNECTED",
      "storedEventsCount": 12,
      "lastDeviceStatusAt": "2026-09-21T00:00:00.000Z"
    },
    "activeCodes": [
      {
        "kind": "malfunction",
        "code": "P"
      }
    ],
    "unidentified": {
      "windowDays": 8,
      "pendingCount": 1,
      "pendingConfirmationRequestIds": [
        "seg_1"
      ]
    },
    "hosDrift": {
      "computedAt": "2026-09-21T00:00:00.000Z",
      "lastComparedAt": "2026-09-21T00:00:05.000Z",
      "maxDriftSec": 4,
      "driftAlerted": false
    }
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/conversations`

**Nima qiladi:** Haydovchi suhbatlari: oxirgi xabar va o'qilmaganlar soni.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileMessagingController_listConversations` · original: _Lists the driver's conversations with the last message and unread count (S-14)._

**Javob `200`:** OK.

```json
{
  "data": {
    "items": [
      {
        "id": "cnv_1",
        "type": "DIRECT",
        "title": "Jane Dispatcher",
        "lastMessageAt": "2026-09-11T15:00:00.000Z",
        "lastMessage": {
          "id": "msg_1",
          "conversationId": "cnv_1",
          "senderUserId": "usr_1",
          "senderDriverId": null,
          "body": "On schedule.",
          "attachmentId": null,
          "clientId": null,
          "sentAt": "2026-09-11T15:00:00.000Z",
          "deliveredAt": null,
          "readAt": null,
          "senderId": "usr_1",
          "senderType": "STAFF",
          "senderName": "Jane Dispatcher"
        },
        "unreadCount": 2,
        "participants": [
          {
            "id": "drv_1",
            "type": "DRIVER",
            "name": "John Smith"
          },
          {
            "id": "usr_1",
            "type": "STAFF",
            "name": "Jane Dispatcher"
          }
        ]
      }
    ]
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/mobile/conversations`

**Nima qiladi:** `GET /mobile/contacts` dagi kontakt bilan suhbat boshlaydi (yoki mavjudini ishlatadi) va birinchi xabarni yuboradi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileMessagingController_startConversation` · original: _MR-3 — starts (or reuses) a conversation with a contact from `GET /mobile/contacts` and sends the first message._
- **Izoh (backend):** `contactId` is a staff user id, the active co-driver id, or `"support"`. An existing DIRECT conversation with that contact is reused. Idempotent on `clientId` (uuid, required): a replay returns the first response. The thread shows in the admin panel conversations list; a `conversation.new` realtime event goes to the staff contact's `user:{id}` room and `message.new` to `conversation:{id}`.

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `contactId` | `support` yoki string (uuid) | ha |  |  |
| `body` | string | ha | 1–2000 belgi |  |
| `clientId` | string (uuid) | ha |  |  |

So'rov misoli:

```json
{
  "contactId": "f3b1c2d4-0000-4000-8000-000000000001",
  "body": "Running 20 min late.",
  "clientId": "0b9d6f5e-0000-4000-8000-000000000002"
}
```

**Javob `201`:** Created.

```json
{
  "data": {
    "conversationId": "cnv_1",
    "message": {
      "id": "msg_1",
      "body": "Running 20 min late.",
      "sentAt": "2026-10-08T15:00:00.000Z",
      "senderId": "drv_1",
      "senderType": "DRIVER",
      "clientId": "0b9d6f5e-0000-4000-8000-000000000002"
    }
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Contact not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/conversations/{id}/messages`

**Nima qiladi:** Suhbat tarixi, cursor pagination.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileMessagingController_listMessages` · original: _Cursor-paginated message history for a conversation the driver participates in._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |
| `before` | query | string (uuid) | yo'q |  |  |
| `limit` | query | integer | yo'q | 1–200, default `50` |  |

**Javob `200`:** OK.

```json
{
  "data": {
    "items": [
      {
        "id": "msg_1",
        "conversationId": "cnv_1",
        "senderUserId": "usr_1",
        "senderDriverId": null,
        "body": "On schedule.",
        "attachmentId": null,
        "clientId": null,
        "sentAt": "2026-09-11T15:00:00.000Z",
        "deliveredAt": null,
        "readAt": null,
        "senderId": "usr_1",
        "senderType": "STAFF",
        "senderName": "Jane Dispatcher"
      }
    ],
    "limit": 50
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Not a participant of this conversation. · `404` NOT_FOUND — Conversation not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/mobile/conversations/{id}/messages`

**Nima qiladi:** Suhbatga xabar yuboradi (realtime `message.new`). `clientId` bo'yicha idempotent.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileMessagingController_sendMessage` · original: _Sends a message into a conversation the driver participates in (fires realtime message.new). Idempotent on clientId: a replay returns the stored message._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `body` | string | ha | 1–2000 belgi |  |
| `attachmentId` | string | yo'q | ≤ 200 belgi |  |
| `clientId` | string | yo'q | ≤ 100 belgi |  |

**Javob `201`:** Created.

```json
{
  "data": {
    "id": "msg_2",
    "conversationId": "cnv_1",
    "senderUserId": null,
    "senderDriverId": "drv_1",
    "body": "Confirmed.",
    "attachmentId": null,
    "clientId": "5d2c...",
    "sentAt": "2026-09-11T15:05:00.000Z",
    "deliveredAt": null,
    "readAt": null,
    "senderId": "drv_1",
    "senderType": "DRIVER",
    "senderName": "John Smith"
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Not a participant of this conversation. · `404` NOT_FOUND — Conversation not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/mobile/conversations/{id}/read`

**Nima qiladi:** Suhbatni o'qilgan qiladi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileMessagingController_markRead` · original: _Marks the conversation read: sets the driver's lastReadAt and readAt on the other side's messages._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** OK.

```json
{
  "data": {
    "messagesMarked": 3
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Not a participant of this conversation. · `404` NOT_FOUND — Conversation not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/maintenance`

**Nima qiladi:** Tanlangan unitning texnik xizmat vazifalari (eng kechikkani birinchi).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileMaintenanceController_list` · original: _M-38 — maintenance tasks of the driver's selected unit (actionable first, most overdue first)._
- **Izoh (backend):** `remainingMi` is relative to the unit odometer; a negative value means overdue by that many miles, `null` = date-only interval. `at` = completion time (COMPLETED), else last submission, else due date. `[]` when no unit is selected.

**Javob `200`:** OK.

```json
{
  "data": [
    {
      "id": "3f2c0a7e-0000-4000-8000-000000000001",
      "scheduleType": "OIL_CHANGE",
      "scheduleName": "Engine oil & filter",
      "frequencyMi": 25000,
      "remainingMi": 1200,
      "status": "OPEN",
      "at": "2026-11-01T00:00:00.000Z"
    }
  ],
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/maintenance/{id}`

**Nima qiladi:** Bitta texnik xizmat vazifasi, yuborilgan invoice va tekshiruvchi izohi bilan.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileMaintenanceController_get` · original: _M-39/M-41 — one maintenance task with the submitted invoice (if any) and the reviewer's note._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** OK.

```json
{
  "data": {
    "id": "3f2c0a7e-0000-4000-8000-000000000001",
    "scheduleType": "OIL_CHANGE",
    "scheduleName": "Engine oil & filter",
    "frequencyMi": 25000,
    "remainingMi": 1200,
    "status": "REJECTED",
    "at": "2026-10-08T12:00:00.000Z",
    "invoiceNumber": "INV-2291",
    "vendorName": "Pilot Truck Care",
    "cost": 412.5,
    "notes": "Changed filters too",
    "invoiceAttachment": {
      "id": "9a1d...",
      "fileName": "invoice-INV-2291.pdf",
      "mimeType": "application/pdf"
    },
    "submittedAt": "2026-10-08T12:00:00.000Z",
    "reviewNote": "Amount does not match the PDF."
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` MAINTENANCE_SCHEDULE_NOT_FOUND — Task not found, or it belongs to a unit other than the selected one. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/mobile/maintenance/{id}/submit`

**Nima qiladi:** Texnik xizmat invoice'ini back-office tekshiruviga yuboradi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileMaintenanceController_submit` · original: _M-40 — submits the service invoice of a maintenance task for back-office review._
- **Izoh (backend):** Allowed while the task is OPEN or REJECTED (resubmit). `invoiceAttachmentId` = `signatureImageId` of `POST /mobile/signature {purpose:"INVOICE", mimeType:"application/pdf"}`. Idempotent on `clientId`: a replay returns the first answer; a `clientId` spent on another operation -> 409. The task stays OPEN with `submittedAt` set until back office approves (COMPLETED) or rejects (REJECTED + `reviewNote`).

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `invoiceNumber` | string | ha | 1–60 belgi |  |
| `vendorName` | string | ha | 1–120 belgi |  |
| `cost` | number yoki string | ha |  |  |
| `notes` | string | yo'q, null mumkin | ≤ 1000 belgi |  |
| `invoiceAttachmentId` | string (uuid) | yo'q, null mumkin |  |  |
| `clientId` | string (uuid) | ha |  |  |

So'rov misoli:

```json
{
  "invoiceNumber": "INV-2291",
  "vendorName": "Pilot Truck Care",
  "cost": 412.5,
  "notes": "Changed filters too",
  "invoiceAttachmentId": "9a1d2b3c-0000-4000-8000-000000000009",
  "clientId": "7d1c2a40-0000-4000-8000-000000000001"
}
```

**Javob `200`:** OK.

```json
{
  "data": {
    "id": "3f2c0a7e-0000-4000-8000-000000000001",
    "scheduleType": "OIL_CHANGE",
    "scheduleName": "Engine oil & filter",
    "frequencyMi": 25000,
    "remainingMi": 1200,
    "status": "OPEN",
    "at": "2026-10-08T12:00:00.000Z",
    "invoiceNumber": "INV-2291",
    "vendorName": "Pilot Truck Care",
    "cost": 412.5,
    "notes": "Changed filters too",
    "invoiceAttachment": {
      "id": "9a1d2b3c-0000-4000-8000-000000000009",
      "fileName": "invoice-INV-2291.pdf",
      "mimeType": "application/pdf"
    },
    "submittedAt": "2026-10-08T12:00:00.000Z",
    "reviewNote": null
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` MAINTENANCE_SCHEDULE_NOT_FOUND — Task not found, or it belongs to a unit other than the selected one. · `409` CONFLICT — The task is COMPLETED/CANCELLED, or clientId was already used by another operation. · `422` VALIDATION_FAILED — invoiceAttachmentId is not an INVOICE upload of this driver.

---

### `POST /api/mobile/device/mac`

**Nima qiladi:** Tanlangan unitga bog'langan ELD'ning ko'rilgan BLE MAC manzilini xabar qiladi (mos kelmasa alert).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileDeviceController_reportMac` · original: _MG-BLE-1/2 — report the BLE MAC observed on the ELD bound to the selected vehicle._
- **Izoh (backend):** `deviceId` must be the device bound to the driver's selected vehicle (`bootstrap.device.id` / `select-vehicle` response `device.id`). Stored MAC empty -> written and audited (`outcome:"STORED"`); equal (any spelling) -> no-op (`outcome:"UNCHANGED"`, safe to replay); different, or the MAC is already on another device -> 409 `DEVICE_MAC_MISMATCH`, audited, back office alerted (`alert.device_mac_mismatch`). `macAddress` accepts `AA:BB:CC:DD:EE:FF`, `aa-bb-cc-dd-ee-ff` or `AABBCCDDEEFF`; it is stored upper-case with colons. The app can never pair, unpair or re-bind a device.

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `deviceId` | string (uuid) | ha |  |  |
| `macAddress` | string | ha |  |  |

So'rov misoli:

```json
{
  "deviceId": "0b6f1c2e-0000-4000-8000-000000000101",
  "macAddress": "A4:C1:38:5E:A8:6E"
}
```

**Javob `200`:** OK.

```json
{
  "data": {
    "deviceId": "0b6f1c2e-0000-4000-8000-000000000101",
    "macAddress": "A4:C1:38:5E:A8:6E",
    "outcome": "STORED"
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEVICE_NOT_FOUND — Device not found, or it is not the ELD bound to your selected vehicle. · `409` Field-level conflict — one of: DEVICE_MAC_MISMATCH (details.deviceId: "The device on record has a different BLE MAC (or the MAC is on ano… · `422` VALIDATION_FAILED — macAddress is not a BLE MAC address.

---

### `GET /api/mobile/device-config` 🆕 YANGI

**Nima qiladi:** 🆕 PT SDK 6.11: ulangan ELD uchun qurilmaga `SetSystemVar` bilan yoziladigan sozlamalar (`systemVars`) va `configVersion`. Versiya o'zgarsa ilova qayta yozadi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileDeviceConfigController_config` · original: _PT SDK 6.11 — device config (system variables) for the ELD the driver is connected to._
- **Izoh (backend):** The device must be paired with a unit the driver is assigned to or has an open login session on (same rule as /ingest/*). Apply every `systemVars` entry that differs from the device; re-apply when `configVersion` changes.

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `serial` | query | string | ha | 1–60 belgi |  |

**Javob `200`:** OK.

```json
{
  "data": {
    "serial": "PT30_A86E",
    "model": "PT30",
    "systemVars": {
      "PERIODIC_EVENT_GAP": 30,
      "PERIODIC_EVENT_GAP_NOBLE": 30,
      "EVENTS_STORED": 1,
      "DRIVING_ACCL": 0,
      "DRIVING_BRAKING": 450,
      "DRIVING_CORNERING": 0,
      "HSI_MODE": 1
    },
    "autoFirmware": true,
    "shareDiagnostics": true,
    "configVersion": "3f9a1c0b7d2e"
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Device is not paired with any unit, or the driver is not associated with its unit. · `404` UNKNOWN_DEVICE — Unknown device serial. · `422` VALIDATION_FAILED — serial is required.

---

### `POST /api/mobile/log-entries`

**Nima qiladi:** Haydovchining o'z log tuzatishi (recordOrigin = 2, darhol faol). 4–60 belgilik izoh majburiy, sertifikat bekor bo'ladi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileLogsController_createEntry` · original: _Driver's own log correction (§9.3): recordOrigin = 2, recordStatus = 1, active immediately. Annotation 4-60 chars is mandatory and certification is invalidated._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `date` | string | yo'q | pattern `^\d{4}-\d{2}-\d{2}$` |  |
| `status` | `OFF` \| `SB` \| `ON` | ha |  |  |
| `startAt` | string (date-time) | ha |  |  |
| `endAt` | string (date-time) | yo'q |  |  |
| `annotation` | string | ha | 4–60 belgi |  |
| `location` | object | yo'q |  |  |
| `location.lat` | number | ha | -90–90 |  |
| `location.lon` | number | ha | -180–180 |  |
| `location.name` | string | yo'q | ≤ 120 belgi |  |
| `locationName` | string | yo'q, null mumkin | 5–60 belgi |  |
| `odometerMi` | integer | yo'q | 0–9999999 |  |
| `engineHours` | number | yo'q, null mumkin | 0–99999 |  |
| `specialCondition` | `NONE` \| `PC` \| `YM` | yo'q, null mumkin |  |  |
| `originalEventId` | string | yo'q | pattern `^\d+$` |  |

**Javob `201`:** recordOrigin = 2 (driver), recordStatus = 1 (active immediately); certification is invalidated.

```json
{
  "data": {
    "id": "9100",
    "driverId": "drv_1",
    "status": "ON",
    "specialCondition": "NONE",
    "locationName": "Columbus, OH",
    "startAt": "2026-09-10T18:26:58.000Z",
    "endAt": null,
    "recordOrigin": 2,
    "recordStatus": 1,
    "applied": true,
    "recertificationRequired": true
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` 422 — one of: DRIVING_TIME_IMMUTABLE (driving time can never be shortened/restatused/hand-entered); SPECIAL_CONDITION_NOT_ALLOWED (MR-23:…

---

### `POST /api/mobile/certify`

**Nima qiladi:** Ilovadan RODS kunlarini sertifikatlaydi; offline navbatga qo'yiladi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileLogsController_certify` · original: _Certifies RODS days from the driver app; queued offline and replayed on sync (§13.2)._
- **Izoh (backend):** MR-5 — idempotent on `clientId` (UUID): a replay with the same `clientId` returns the FIRST response and appends no second certification record, so `certificationCount` does not move. The same key space is shared with `/mobile/sync` `certify` changes.

Re-certification: certifying a day that is already certified, or one whose certification was voided by a later change (`recertificationRequired: true` in `GET /mobile/logs` / `GET /mobile/certification-status`), is always accepted and appends a new eventType 4 record (event code 2..9). This endpoint therefore never returns `422 RECERTIFICATION_REQUIRED` — that code is a state, read from `recertificationRequired`. 422 `VALIDATION_FAILED` is returned for a future date.

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `dates` | string[] | ha | 1–31 ta |  |
| `signatureImageId` | string | yo'q | ≤ 200 belgi |  |
| `driverId` | string (uuid) | yo'q |  |  |
| `clientId` | string (uuid) | yo'q |  |  |

**Javob `201`:** Created.

```json
{
  "data": {
    "driverId": "drv_1",
    "days": [
      {
        "date": "2026-09-10",
        "certified": true,
        "certificationCount": 1,
        "eventCode": 1,
        "certifiedAt": "2026-09-11T15:41:00.000Z",
        "certifierType": "DRIVER"
      }
    ]
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/log-edit-requests`

**Nima qiladi:** Haydovchini kutayotgan carrier tahrir takliflari.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileLogsController_listEditRequests` · original: _Carrier edit proposals waiting for this driver (§395.30 — nothing applies until they answer)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `status` | query | `PENDING` \| `ACCEPTED` \| `REJECTED` \| `ALL` | yo'q | default `"PENDING"` |  |
| `from` | query | string | yo'q | pattern `^\d{4}-\d{2}-\d{2}$` |  |
| `to` | query | string | yo'q | pattern `^\d{4}-\d{2}-\d{2}$` |  |

**Javob `200`:** OK.

```json
{
  "data": {
    "driverId": "drv_1",
    "items": [
      {
        "id": "9120",
        "driverId": "drv_1",
        "status": "PENDING",
        "kind": "EDIT",
        "originalEventId": "9100",
        "proposedStatus": "ON",
        "proposedSpecial": "NONE",
        "proposedStart": "2026-09-10T18:26:58.000Z",
        "proposedEnd": "2026-09-10T19:30:00.000Z",
        "locationName": "Columbus, OH",
        "annotation": "Forgot to switch to On duty while loading",
        "requestedById": "usr_1",
        "requestedAt": "2026-09-11T14:00:00.000Z",
        "resolvedAt": null
      }
    ]
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/certification-status`

**Nima qiladi:** Oxirgi `days` kunning (default 8, max 14) sertifikatsiya holati.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileLogsController_certificationStatus` · original: _MR-26 — certification state of the last `days` RODS days (default 8, max 14), today included, oldest first._
- **Izoh (backend):** `recertificationRequired` is true only for a day that WAS certified and changed afterwards (`certified=false && certificationCount>0`). A day with no records yet is `certified:false`.

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `days` | query | integer | yo'q | 1–14, default `8` | How many RODS days, today included (1-14, default 8 = the §395 8-day inspection window). |

**Javob `200`:** OK.

```json
{
  "data": [
    {
      "date": "2026-10-07",
      "certified": true,
      "certifiedAt": "2026-10-08T01:02:00.000Z",
      "certificationCount": 1,
      "recertificationRequired": false
    },
    {
      "date": "2026-10-08",
      "certified": false,
      "certifiedAt": null,
      "certificationCount": 1,
      "recertificationRequired": true
    }
  ],
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/logs`

**Nima qiladi:** Haydovchining o'z RODS kuni (grafik, yozuvlar, sertifikatsiya).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileLogsController_getDay` · original: _The driver's own RODS day (grid, records, certification state)._
- **Izoh (backend):** Additive fields (2026-10-08): `trip` {shippingDocuments, trailerNumbers, notes, bobtail, tripIds, tripNumbers} from the trips overlapping the day (MR-12), merged (D-129) with the driver's no-trip day details for that day (union of lists, trip notes win; `dayDetails: true` when a day-details row exists — written by `PATCH /mobile/trip` with no active trip); `malfunctionIndicator` / `diagnosticIndicator` — an Appendix A malfunction / data diagnostic was in force at some instant of the day (MR-16); every `graph` segment carries `eventId`, `locationDescription`, `odometerMi`, `engineHours`, `annotation`, `carriedOver` of the record that opened it, and every event `eventId`, `locationDescription`, `odometerMi`, `engineHours`, `specialCondition` (MR-13). `locationDescription` is the stored location text (device-provided or driver-entered); when there is none, the server computes the §395 Appendix A 7.29 geo-location offline from the stored position (`3mi W OH Columbus`, PC: 10-mile steps — `docs/location-description.md`).

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `date` | query | string (date) | yo'q |  | RODS day (home-terminal zone); default today. |

**Javob `200`:** OK.

```json
{
  "data": {
    "driverId": "drv_1",
    "date": "2026-09-10",
    "timezone": "America/New_York",
    "summary": {
      "date": "2026-09-10",
      "timezone": "America/New_York",
      "offDutySec": 39600,
      "sleeperSec": 7200,
      "drivingSec": 32400,
      "onDutySec": 7200,
      "totalDistanceMi": 512,
      "dayLengthSec": 86400,
      "certified": false,
      "certifiedAt": null,
      "certificationCount": 0,
      "hasViolation": false,
      "violationCount": 0,
      "hasUnassigned": false,
      "hasEdits": false
    },
    "graph": [
      {
        "status": "OFF",
        "effective": "OFF",
        "special": "NONE",
        "startAt": "2026-09-10T04:00:00.000Z",
        "endAt": "2026-09-10T05:00:00.000Z",
        "durationSec": 3600,
        "eventId": "9100",
        "locationDescription": "3mi W OH Columbus",
        "odometerMi": 120345,
        "engineHours": 5321.4,
        "annotation": null,
        "carriedOver": true
      }
    ],
    "events": [
      {
        "id": "9101",
        "eventType": 1,
        "eventCode": 3,
        "eventSequenceId": 1043,
        "eventDateTime": "2026-09-10T05:00:00.000Z",
  …
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/logs/{date}/export`

**Nima qiladi:** Haydovchining bitta RODS kunini yuklab beradi: `format=csv` ishlaydi, `pdf` → 501.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileLogsExportController_exportDay` · original: _Downloads one of the driver's own RODS days. format=csv → text/csv (every §395 record of the day, home-terminal local time). format=pdf → 501 NOT_IMPLEMENTED for now._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `format` | query | `csv` \| `pdf` | yo'q | default `"csv"` |  |

**Javob `200`:** Raw CSV (not wrapped in the success envelope), `Content-Disposition: attachment; filename="RODS_<date>.csv"`.

```json
"sequenceId,eventType,eventCode,eventDateTime,status,location,odometerMi,engineHours,origin,recordStatus,annotation\r\n17,1,3,2026-09-10 09:00:00,D,\"New Haven, CT\",993107,4321.4,ELD,ACTIVE,\r\n"
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Driver token required (DRIVER_CONTEXT_REQUIRED). · `404` DRIVER_NOT_FOUND — Driver not found. · `422` VALIDATION_FAILED — Request validation failed. · `501` NOT_IMPLEMENTED — PDF export of a RODS day is not available yet.

---

### `POST /api/mobile/hos-state`

**Nima qiladi:** Mobil engine hisoblagan HOS holatini qabul qiladi, saqlaydi va server bilan solishtiradi (drift).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `HosStateController_hosStateSubmit` · original: _Receives the HOS state computed by the mobile engine, stores it and compares it with the server (§8.6)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `computedAt` | string (date-time) | ha |  |  |
| `hosEngineVersion` | string | ha | 1–32 belgi |  |
| `appPlatform` | `IOS` \| `ANDROID` | yo'q |  |  |
| `state` | object | ha |  |  |
| `state.currentStatus` | `OFF` \| `SB` \| `D` \| `ON` | ha |  |  |
| `state.driveRemainingSec` | integer | ha | 0–604800 |  |
| `state.shiftRemainingSec` | integer | ha | 0–604800 |  |
| `state.breakRemainingSec` | integer | ha | 0–604800 |  |
| `state.cycleRemainingSec` | integer | ha | 0–604800 |  |
| `state.dailyTotals` | object | ha |  |  |
| `state.dailyTotals.off` | integer | ha | 0–604800 |  |
| `state.dailyTotals.sb` | integer | ha | 0–604800 |  |
| `state.dailyTotals.drive` | integer | ha | 0–604800 |  |
| `state.dailyTotals.on` | integer | ha | 0–604800 |  |
| `state.violations` | object[] | yo'q | ≤ 50 ta, default `[]` |  |
| `state.violations[].type` | `DRIVING_11` \| `SHIFT_14` \| `BREAK_30` \| `CYCLE_70` \| `CYCLE_60` \| `FORM_MANNER` | ha |  |  |
| `state.violations[].exceededBySec` | integer | ha | 0–604800 |  |
| `state.statusSince` | string (date-time) | yo'q, null mumkin |  | MR-24 — ISO-8601: when the current duty status started. |
| `state.nextBreakDueAt` | string (date-time) | yo'q, null mumkin |  | MR-24 — ISO-8601 or null: when the 30-minute break is due. |
| `state.shiftEndsAt` | string (date-time) | yo'q, null mumkin |  | MR-24 — ISO-8601 or null: when the 14-hour window ends. |
| `state.cycleRecapAt` | string (date-time) | yo'q, null mumkin |  | MR-24 — ISO-8601 or null: when recap hours drop off the cycle. |
| `state.restartAvailableAt` | string (date-time) | yo'q, null mumkin |  | MR-24 — ISO-8601 or null: when the current rest reaches a 34-hour restart. |

**Javob `200`:** Stored. The server state is computed AT `computedAt` (MR-1), not at request time. `compared: false` comes with `reason`: `VERSION_MISMATCH` (the app runs a different HOS_ENGINE_VERSION — never a drift alert; `updateRequired: true` when the app engine is older than the server engine, show the "update the app" banner) or `STALE` (`computedAt` is more than 3600 s old; `staleSec` says how old — no drift alert is raised). `drift: true` means the server raised `alert.hos_engine_drift`. `serverState` carries the MR-24 timestamps (`statusSince`, `nextBreakDueAt`, `shiftEndsAt`, `cycleRecapAt`, `restartAvailableAt`; ISO-8601 or null).

```json
{
  "data": {
    "hosEngineVersion": "1.0.3",
    "accepted": true,
    "versionMismatch": false,
    "updateRequired": false,
    "compared": true,
    "drift": false,
    "maxDriftSec": 0,
    "fields": [],
    "statusMismatch": false,
    "serverState": {
      "currentStatus": "D",
      "driveRemainingSec": 3600,
      "shiftRemainingSec": 7200,
      "breakRemainingSec": 1800,
      "cycleRemainingSec": 36000,
      "dailyTotals": {
        "off": 3600,
        "sb": 0,
        "drive": 36000,
        "on": 1800
      },
      "violations": [],
      "statusSince": "2026-10-08T13:00:00.000Z",
      "nextBreakDueAt": "2026-10-08T15:30:00.000Z",
      "shiftEndsAt": "2026-10-08T17:00:00.000Z",
      "cycleRecapAt": null,
      "restartAvailableAt": null
    },
    "driftThresholdSec": 60
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — DRIVER_CONTEXT_REQUIRED — this endpoint accepts a driver token only. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/mobile/feedback`

**Nima qiladi:** Haydovchi ilovasidan fikr-mulohaza yuboradi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileSupportController_createFeedback` · original: _M-23/P-10 — submits in-app feedback from the driver app._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `answers` | object | ha |  | MR-28 — the 4-question survey (M-22): the selected chip value (string) or score (number) per question. Extra keys are accepted and stored. |
| `answers.tenure` | string yoki number | yo'q |  |  |
| `answers.ease` | string yoki number | yo'q |  |  |
| `answers.hosSatisfaction` | string yoki number | yo'q |  |  |
| `answers.recommend` | string yoki number | yo'q |  |  |
| `comment` | string | yo'q | ≤ 1000 belgi |  |
| `appVersion` | string | yo'q | ≤ 40 belgi |  |
| `platform` | string | yo'q | ≤ 40 belgi |  |
| `clientId` | string (uuid) | yo'q |  | MR-20 — idempotency key; a replay returns the first row. |

**Javob `201`:** Created.

```json
{
  "data": {
    "id": "fbk_1",
    "driverId": "drv_1",
    "userId": null,
    "answers": {
      "tenure": "1-3 years",
      "ease": "Easy",
      "hosSatisfaction": "Satisfied",
      "recommend": 9,
      "overallExperience": 5
    },
    "comment": "Great app!",
    "appVersion": "1.0.3",
    "platform": "android",
    "createdAt": "2026-09-21T00:00:00.000Z"
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/mobile/support/tickets`

**Nima qiladi:** Ilovadan support tiketi ochadi ("Send diagnostics to support" ham shu, category: diagnostics). Ixtiyoriy `contactMethod`.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileSupportController_createTicket` · original: _M-30/M-22 — opens a support ticket from the driver app (also used by "Send diagnostics to support", category: diagnostics). MR-20: optional `contactMethod` (EMAIL|PHONE) and idempotent `clientId`._
- **Izoh (backend):** `contactMethod` (EMAIL | PHONE, optional, null = not said) is stored on the ticket and returned by `GET /mobile/support/tickets` and `GET /mobile/support/tickets/{id}`. A replay with the same `clientId` returns the first ticket unchanged.

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `subject` | string | ha | 1–200 belgi |  |
| `body` | string | ha | 1–5000 belgi |  |
| `category` | string | yo'q | ≤ 100 belgi |  |
| `priority` | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT` | yo'q |  |  |
| `vehicleId` | string (uuid) | yo'q |  |  |
| `attachments` | object[] | yo'q | ≤ 2 ta |  |
| `attachments[].kind` | `DEVICE_DIAGNOSTICS` \| `ELD_EVENTS_24H` | ha |  |  |
| `contactMethod` | `EMAIL` \| `PHONE` | yo'q, null mumkin |  |  |
| `clientId` | string (uuid) | yo'q |  |  |

**Javob `201`:** Created.

```json
{
  "data": {
    "id": "tck_9",
    "number": "TCK-000009",
    "subject": "App crashes on certify",
    "body": "It closes after tapping Certify.",
    "category": "diagnostics",
    "priority": "NORMAL",
    "status": "OPEN",
    "createdByUserId": null,
    "createdByDriverId": "drv_1",
    "assignedToId": null,
    "contactMethod": "PHONE",
    "createdAt": "2026-10-08T00:00:00.000Z",
    "updatedAt": "2026-10-08T00:00:00.000Z",
    "resolvedAt": null
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/support/tickets`

**Nima qiladi:** Haydovchining o'z support tiketlari.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileSupportController_listOwnTickets` · original: _M-30/M-22 — lists the calling driver's own support tickets._

**Javob `200`:** OK.

```json
{
  "data": {
    "items": [
      {
        "id": "tck_1",
        "number": "TCK-000001",
        "subject": "App crashes on certify",
        "body": "It closes after tapping Certify.",
        "category": "diagnostics",
        "priority": "NORMAL",
        "status": "OPEN",
        "contactMethod": null,
        "createdAt": "2026-09-21T00:00:00.000Z",
        "updatedAt": "2026-09-21T00:00:00.000Z"
      }
    ]
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/mobile/support/tickets/{id}`

**Nima qiladi:** Haydovchining bitta tiketi (boshqasiniki → 404).

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `MobileSupportController_getOwnTicket` · original: _MR-20 — one of the calling driver's own support tickets (404 for any other id)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** OK.

```json
{
  "data": {
    "id": "tck_9",
    "number": "TCK-000009",
    "subject": "App crashes on certify",
    "body": "It closes after tapping Certify.",
    "category": "diagnostics",
    "priority": "NORMAL",
    "status": "OPEN",
    "contactMethod": null,
    "createdAt": "2026-10-08T00:00:00.000Z",
    "updatedAt": "2026-10-08T00:00:00.000Z"
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Support ticket not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-notifications"></a>

## Bildirishnomalar

### `GET /api/notifications` ♻️ O'ZGARGAN

**Nima qiladi:** Chaqiruvchining in-app bildirishnomalari, segment sonlari bilan. 🆕 yangi tur: `alert.device_vin_mismatch`.

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `NotificationsController_list` · original: _Lists the caller's own in-app notifications, with segment counts._
- **Izoh (backend):** Every item carries `createdAt` (ISO-8601, newest first). `total`/`totalPages` describe the filtered list (honour `unreadOnly`/`category`). `counts` are TOTAL rows per segment (read + unread), ignoring `unreadOnly`/`category` — they are NOT unread counts. `unreadCount` is the number of unread notifications across all categories (badge number).

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `category` | query | `VIOLATIONS` \| `MAINTENANCE` | yo'q |  |  |
| `unreadOnly` | query | boolean | yo'q | default `false` |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |

**Javob `200`:** OK.

```json
{
  "data": {
    "items": [
      {
        "id": "ntf_1",
        "userId": "usr_1",
        "driverId": null,
        "type": "hos_violation",
        "kind": "VIOLATION",
        "title": "HOS violation",
        "body": "An HOS violation was detected.",
        "objectType": "Driver",
        "objectId": "drv_1",
        "category": "VIOLATIONS",
        "severity": "CRITICAL",
        "readAt": null,
        "createdAt": "2026-10-08T15:41:00.000Z"
      }
    ],
    "page": 1,
    "limit": 25,
    "total": 1,
    "totalPages": 1,
    "counts": {
      "all": 12,
      "violations": 5,
      "maintenance": 3
    },
    "unreadCount": 4
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/notifications/read-all`

**Nima qiladi:** Barcha o'qilmagan bildirishnomalarni o'qilgan qiladi.

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `NotificationsController_readAll` · original: _Marks every unread notification of the caller as read._

**Javob `201`:** Created.

```json
{
  "data": {
    "updated": 3
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/notifications/{id}/read`

**Nima qiladi:** Bitta bildirishnomani o'qilgan qiladi.

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `NotificationsController_markRead` · original: _Marks one of the caller's own notifications as read._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `201`:** Created.

```json
{
  "data": {
    "id": "ntf_1",
    "readAt": "2026-09-24T15:41:00.000Z"
  },
  "traceId": "01J8X3QK9Z0000000000000000",
  "timestamp": "2026-10-08T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Notification not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-logs"></a>

## RODS loglar

### `POST /api/logs/edit-requests/{id}/accept`

**Nima qiladi:** Haydovchi carrier tahririni qabul qiladi (§395.30): taklif faol yozuvga aylanadi, asl yozuv "Inactive — Changed" bo'ladi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`
- **operationId:** `LogsController_accept` · original: _Driver accepts a carrier edit (§395.30): the proposal becomes the active record and the original is marked Inactive — Changed._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `note` | string | yo'q | 4–60 belgi |  |

**Javob `201`:** The proposal is now the active record; the original keeps recordStatus = 2 (Inactive — Changed).

```json
{
  "id": "edt_1",
  "status": "ACCEPTED",
  "resolvedAt": "2026-09-11T15:41:00.000Z",
  "activeEventId": "evt_9001",
  "supersededEventId": "evt_8801",
  "recertificationRequired": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Edit request not found. · `409` EDIT_ALREADY_RESOLVED — This edit request was already accepted or rejected. · `422` DRIVING_TIME_IMMUTABLE — Driving time can never be shortened, deleted or restatused (49 CFR §395.30).

---

### `POST /api/logs/edit-requests/{id}/reject`

**Nima qiladi:** Haydovchi carrier tahririni rad etadi (§395.30): so'rov yopiladi, log o'zgarmaydi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`
- **operationId:** `LogsController_reject` · original: _Driver rejects a carrier edit (§395.30): the request is closed, the log is unchanged._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `note` | string | yo'q | 4–60 belgi |  |

**Javob `201`:** The request is closed and the log is untouched.

```json
{
  "id": "edt_1",
  "status": "REJECTED",
  "resolvedAt": "2026-09-11T15:41:00.000Z",
  "driverComment": "I was off duty, not on duty."
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Edit request not found. · `409` EDIT_ALREADY_RESOLVED — This edit request was already accepted or rejected. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-ingest"></a>

## Ingest (ELD → server)

### `POST /api/ingest/events`

**Nima qiladi:** Ilova hisoblagan §395 Appendix A hodisalarini batch'da yuklaydi (max 500 ta / 1 MB, bitta tranzaksiya). `uuid` bo'yicha dublikat qayta yozilmaydi.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `IngestController_events` · original: _Uploads a batch of §395 ELD events from the app (max 500 events / 1 MB, one transaction)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `deviceSerial` | string | ha | 1–60 belgi |  |
| `vehicleId` | string (uuid) | ha |  |  |
| `sdkVersion` | string | yo'q | ≤ 20 belgi |  |
| `batch` | object[] | ha | 1–500 ta |  |
| `batch[].uuid` | string | ha | 8–64 belgi |  |
| `batch[].eventType` | integer | ha | 1–7 |  |
| `batch[].eventCode` | integer | ha | 0–9 |  |
| `batch[].eventDateTime` | string (date-time) | ha |  |  |
| `batch[].timezoneOffset` | integer | ha | -840–840 |  |
| `batch[].recordStatus` | integer | yo'q | 1–4, default `1` |  |
| `batch[].recordOrigin` | integer | ha | 1–4 |  |
| `batch[].wasStoredOnDevice` | boolean | yo'q | default `false` |  |
| `batch[].latitude` | number | yo'q, null mumkin | -90–90 |  |
| `batch[].longitude` | number | yo'q, null mumkin | -180–180 |  |
| `batch[].locationName` | string | yo'q, null mumkin | ≤ 120 belgi |  |
| `batch[].locationSource` | integer | yo'q, null mumkin | 0–9 |  |
| `batch[].distanceSinceLastValidCoords` | integer | yo'q, null mumkin | ≥ 0 |  |
| `batch[].rawDeviceOdometerKm` | number | yo'q, null mumkin | ≥ 0 |  |
| `batch[].totalEngineHours` | number | yo'q, null mumkin | ≥ 0 |  |
| `batch[].malfunctionCode` | string | yo'q, null mumkin | ≤ 1 belgi |  |
| `batch[].diagnosticCode` | string | yo'q, null mumkin | ≤ 1 belgi |  |
| `batch[].annotation` | string | yo'q, null mumkin | ≤ 60 belgi |  |
| `batch[].comment` | string | yo'q, null mumkin | ≤ 500 belgi |  |
| `batch[].checksum` | string | yo'q, null mumkin | ≤ 128 belgi |  |

**Javob `200`:** Stored. Duplicates by `uuid` are counted, not re-inserted.

```json
{
  "accepted": 118,
  "duplicates": 2,
  "sequenceIds": {
    "drv_1": [
      1042,
      1043
    ]
  },
  "warnings": [],
  "malfunctions": [],
  "diagnostics": [],
  "unidentifiedSegmentIds": [],
  "confirmationRequests": []
}
```

**Javob `202`:** ACCEPTED_WITH_WARNINGS — stored, but at least one event had a bad checksum, a drifted clock or an implausible odometer (§7.3 rules 4/5, §4.3).

```json
{
  "accepted": 120,
  "duplicates": 0,
  "sequenceIds": {
    "drv_1": [
      1042
    ]
  },
  "warnings": [
    {
      "uuid": "8f14e45f-ceea-467a-9575-8b1d6b1c9f11",
      "code": "CHECKSUM_MISMATCH",
      "detail": "Checksum mismatch (expected 3A, got 1F)."
    }
  ],
  "malfunctions": [],
  "diagnostics": [
    "3"
  ],
  "unidentifiedSegmentIds": [],
  "confirmationRequests": []
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — DRIVER_CONTEXT_REQUIRED — ingest accepts a driver token only. · `413` PAYLOAD_TOO_LARGE — Ingest batch exceeds the 1 MB limit. · `422` VALIDATION_FAILED — Schema violation — the only reason an event is ever rejected.

---

### `POST /api/ingest/telemetry` ♻️ O'ZGARGAN

**Nima qiladi:** 🆕 Virtual Dashboard nuqtalarini yuklaydi (1 nuqta/60 s). SDK 6.11: lat/lon ixtiyoriy (GPS'siz nuqta), loadPct 0–250, gear int/string, busType SDK yozilishlari, yangi VDB maydonlari, `dtcCodes[]` shina bo'yicha (J1939 SPN/FMI, J1708 SID/PID, OBD-II kod), `milOn`, `vin`.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `IngestController_telemetry` · original: _Uploads Virtual Dashboard points (app downsamples to 1/60 s, §7.5)._
- **Izoh (backend):** PT SDK 6.11: `latitude`/`longitude` optional (no GPS lock — stored without a position); `loadPct` 0–250; `gear` int or string (stored as text); `busType` accepts `J1939|J1708|OBD_II`, `OBDII|OBD2|OBD-II` or bits 1/2/4 (unknown -> null); `dtcCodes[]` (max 50) carry J1939 `spn/fmi/occurrence/conversionMethod`, J1708 `code` or `spn`+`isSid`, `fmi`, `active`, OBD-II `code`; point `milOn` applies to them; `vin` updates `Device.reportedVin`.

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `deviceSerial` | string | ha | 1–60 belgi |  |
| `vehicleId` | string (uuid) | ha |  |  |
| `points` | object[] | ha | 1–500 ta |  |
| `points[].time` | string (date-time) | ha |  |  |
| `points[].latitude` | number | yo'q, null mumkin | -90–90 |  |
| `points[].longitude` | number | yo'q, null mumkin | -180–180 |  |
| `points[].speedKmh` | number | yo'q, null mumkin | 0–400 |  |
| `points[].headingDeg` | integer | yo'q, null mumkin | 0–359 |  |
| `points[].odometerKm` | number | yo'q, null mumkin | ≥ 0 |  |
| `points[].engineHours` | number | yo'q, null mumkin | ≥ 0 |  |
| `points[].idleHours` | number | yo'q, null mumkin | ≥ 0 |  |
| `points[].ptoHours` | number | yo'q, null mumkin | ≥ 0 |  |
| `points[].engineOn` | boolean | yo'q, null mumkin |  |  |
| `points[].rpm` | integer | yo'q, null mumkin | 0–10000 |  |
| `points[].gear` | integer yoki string | yo'q, null mumkin |  |  |
| `points[].seatBelt` | boolean | yo'q, null mumkin |  |  |
| `points[].loadPct` | integer | yo'q, null mumkin | 0–250 |  |
| `points[].fuelPct` | integer | yo'q, null mumkin | 0–100 |  |
| `points[].fuelPct2` | integer | yo'q, null mumkin | 0–100 |  |
| `points[].defPct` | integer | yo'q, null mumkin | 0–100 |  |
| `points[].fuelRateLph` | number | yo'q, null mumkin | ≥ 0 |  |
| `points[].fuelEconomyKmpl` | number | yo'q, null mumkin | ≥ 0 |  |
| `points[].totalFuelUsedL` | number | yo'q, null mumkin | ≥ 0 |  |
| `points[].totalFuelIdleL` | number | yo'q, null mumkin | ≥ 0 |  |
| `points[].oilPressureKpa` | number | yo'q, null mumkin | ≥ 0 |  |
| `points[].oilPct` | integer | yo'q, null mumkin | 0–100 |  |
| `points[].oilTempC` | integer | yo'q, null mumkin | -60–250 |  |
| `points[].coolantPct` | integer | yo'q, null mumkin | 0–100 |  |
| `points[].coolantTempC` | integer | yo'q, null mumkin | -60–250 |  |
| `points[].intakeTempC` | integer | yo'q, null mumkin | -60–250 |  |
| `points[].ambientTempC` | integer | yo'q, null mumkin | -60–100 |  |
| `points[].transmOilTempC` | integer | yo'q, null mumkin | -60–250 |  |
| `points[].intakePressureKpa` | number | yo'q, null mumkin | 0–9999 |  |
| `points[].barometerKpa` | number | yo'q, null mumkin | 0–999 |  |
| `points[].fuelTempC` | integer | yo'q, null mumkin | -60–250 |  |
| `points[].intercoolerTempC` | integer | yo'q, null mumkin | -60–250 |  |
| `points[].turboOilTempC` | integer | yo'q, null mumkin | -60–250 |  |
| `points[].retarderPct` | integer | yo'q, null mumkin | -125–125 |  |
| `points[].brakePedal` | integer | yo'q, null mumkin | 0–255 |  |
| `points[].odometerComputed` | boolean | yo'q, null mumkin |  |  |
| `points[].engineHoursComputed` | boolean | yo'q, null mumkin |  |  |
| `points[].gpsLocked` | boolean | yo'q, null mumkin |  |  |
| `points[].gpsSatellites` | integer | yo'q, null mumkin | 0–99 |  |
| `points[].gpsDop` | number | yo'q, null mumkin | 0–999 |  |
| `points[].gpsAgeSec` | integer | yo'q, null mumkin | ≥ 0 |  |
| `points[].vin` | string | yo'q, null mumkin | ≤ 20 belgi |  |
| `points[].milOn` | boolean | yo'q, null mumkin |  |  |
| `points[].dtcCount` | integer | yo'q, null mumkin | ≥ 0 |  |
| `points[].dtcCodes` | object[] | yo'q, null mumkin | ≤ 50 ta |  |
| `points[].dtcCodes[].spn` | integer | yo'q, null mumkin | 0–999999 |  |
| `points[].dtcCodes[].fmi` | integer | yo'q, null mumkin | 0–31 |  |
| `points[].dtcCodes[].code` | string | yo'q, null mumkin | 1–20 belgi |  |
| `points[].dtcCodes[].occurrence` | integer | yo'q, null mumkin | 0–255 |  |
| `points[].dtcCodes[].bus` | string yoki integer | yo'q, null mumkin |  |  |
| `points[].dtcCodes[].conversionMethod` | integer | yo'q, null mumkin | 0–1 |  |
| `points[].dtcCodes[].isSid` | boolean | yo'q, null mumkin |  |  |
| `points[].dtcCodes[].active` | boolean | yo'q, null mumkin |  |  |
| `points[].dtcCodes[].source` | string | yo'q, null mumkin | ≤ 40 belgi |  |
| `points[].dtcCodes[].description` | string | yo'q, null mumkin | ≤ 200 belgi |  |
| `points[].busType` | string yoki integer | yo'q, null mumkin |  |  |
| `points[].voltage` | number | yo'q, null mumkin | 0–99 |  |
| `points[].isTransition` | boolean | yo'q | default `false` |  |

So'rov misoli:

```json
{
  "deviceSerial": "PT30_A86E",
  "vehicleId": "0b6f1c2e-0000-4000-8000-000000000201",
  "points": [
    {
      "time": "2026-10-10T12:00:00Z",
      "latitude": 41.8781,
      "longitude": -87.6298,
      "speedKmh": 88,
      "headingDeg": 270,
      "odometerKm": 182345.6,
      "engineHours": 5123.4,
      "rpm": 1350,
      "gear": 10,
      "loadPct": 145,
      "busType": "J1939",
      "intakePressureKpa": 180,
      "barometerKpa": 99.1,
      "gpsLocked": true,
      "gpsSatellites": 9,
      "gpsDop": 1.1,
      "gpsAgeSec": 0,
      "milOn": true,
      "dtcCount": 1,
      "dtcCodes": [
        {
          "spn": 100,
          "fmi": 1,
          "occurrence": 3,
          "conversionMethod": 0
        }
      ],
      "isTransition": false
    },
    {
      "time": "2026-10-10T12:01:00Z",
      "latitude": null,
      "longitude": null,
      "gpsLocked": false,
      "rpm": 1300,
      "busType": 4
    }
  ]
}
```

**Javob `200`:** Virtual Dashboard points; the app already downsampled to 1/60 s (§7.5).

```json
{
  "accepted": 60,
  "duplicates": 0,
  "denserThanContract": 0
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — DRIVER_CONTEXT_REQUIRED — ingest accepts a driver token only. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/ingest/device-events` 🆕 YANGI

**Nima qiladi:** 🆕 PT SDK xom TelemetryEvent'larini yuklaydi (EV_POWER/IGNITION/ENGINE/TRIP/PERIODIC/BLE/BUS/MEMS; live + stored; max 500 / 1 MB). (deviceId, occurredAt, seq) bo'yicha idempotent; EV_MEMS_* → SafetyEvent + harsh alert.

- **Auth:** `Authorization: Bearer <driver access token>`
- **operationId:** `IngestController_deviceEventsUpload` · original: _Uploads raw PT SDK TelemetryEvents (live + stored; max 500 / 1 MB, one transaction)._
- **Izoh (backend):** Not §395 records (those still go to /ingest/events). `type` = SDK name (`EV_MEMS_BRK`) or enum (`HARSH_BRAKE`); unknown -> `UNKNOWN`. Idempotent on (device, occurredAt, seq) — the SDK ACK key. Newly stored `HARSH_ACCEL/BRAKE/CORNER` create a SafetyEvent (HARSH_ACCEL / HARSH_BRAKING / HARSH_TURN) and raise `alert.harsh_event`. Coordinates are coarsened before storage.

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `deviceSerial` | string | ha | 1–60 belgi |  |
| `vehicleId` | string (uuid) | ha |  |  |
| `events` | object[] | ha | 1–500 ta |  |
| `events[].type` | string | ha | 1–40 belgi |  |
| `events[].seq` | integer | ha | ≥ 0 |  |
| `events[].hsi` | integer | yo'q, null mumkin | ≥ 0 |  |
| `events[].occurredAt` | string (date-time) | ha |  |  |
| `events[].live` | boolean | ha |  |  |
| `events[].latitude` | number | yo'q, null mumkin | -90–90 |  |
| `events[].longitude` | number | yo'q, null mumkin | -180–180 |  |
| `events[].headingDeg` | integer | yo'q, null mumkin | 0–359 |  |
| `events[].gpsLocked` | boolean | yo'q, null mumkin |  |  |
| `events[].gpsSatellites` | integer | yo'q, null mumkin | 0–99 |  |
| `events[].gpsDop` | number | yo'q, null mumkin | 0–999 |  |
| `events[].gpsAgeSec` | integer | yo'q, null mumkin | ≥ 0 |  |
| `events[].odometerKm` | number yoki string | yo'q, null mumkin |  |  |
| `events[].speedKmh` | number | yo'q, null mumkin | 0–400 |  |
| `events[].engineHours` | number yoki string | yo'q, null mumkin |  |  |
| `events[].rpm` | integer | yo'q, null mumkin | 0–10000 |  |
| `events[].obd2` | boolean | yo'q, null mumkin |  |  |
| `events[].engineAgeSec` | integer | yo'q, null mumkin | ≥ 0 |  |

So'rov misoli:

```json
{
  "deviceSerial": "PT30_A86E",
  "vehicleId": "0b6f1c2e-0000-4000-8000-000000000201",
  "events": [
    {
      "type": "EV_ENGINE_ON",
      "seq": 41,
      "hsi": 1203,
      "occurredAt": "2026-10-10T11:58:02Z",
      "live": true,
      "latitude": 41.8781,
      "longitude": -87.6298,
      "gpsLocked": true,
      "gpsSatellites": 9,
      "odometerKm": "182345.6",
      "engineHours": "5123.4",
      "rpm": 650
    },
    {
      "type": "EV_MEMS_BRK",
      "seq": 42,
      "occurredAt": "2026-10-10T12:03:10Z",
      "live": true,
      "latitude": 41.88,
      "longitude": -87.63,
      "headingDeg": 270,
      "speedKmh": 72,
      "rpm": 1400
    }
  ]
}
```

**Javob `200`:** Duplicates (same device + occurredAt + seq) are counted, not re-inserted.

```json
{
  "received": 2,
  "stored": 2,
  "duplicates": 0,
  "safetyEvents": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — DRIVER_CONTEXT_REQUIRED — ingest accepts a driver token only; or the device/unit is not yours. · `413` PAYLOAD_TOO_LARGE — Ingest batch exceeds the 1 MB limit. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/ingest/ble-state` ♻️ O'ZGARGAN

**Nima qiladi:** BLE holati o'zgarishini xabar qiladi: CONNECTED / OUT_OF_RANGE / DISCONNECTED. 🆕 ixtiyoriy `connectionType` BLE|USB.

- **Auth:** `Authorization: Bearer <driver access token>`
- **Ekran:** `{'id': 'web/settings-eld-devices', 'title': 'Settings · ELD devices', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `IngestController_bleState` · original: _Reports a BLE state transition (§7.6): CONNECTED / OUT_OF_RANGE / DISCONNECTED; optional `connectionType` BLE|USB (SDK 6.11)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `deviceSerial` | string | ha | 1–60 belgi |  |
| `state` | `CONNECTED` \| `OUT_OF_RANGE` \| `DISCONNECTED` | ha |  |  |
| `at` | string (date-time) | yo'q |  |  |
| `connectionType` | `BLE` \| `USB` | yo'q |  |  |

So'rov misoli:

```json
{
  "deviceSerial": "PT30_A86E",
  "state": "CONNECTED",
  "at": "2026-10-10T12:00:00Z",
  "connectionType": "USB"
}
```

**Javob `200`:** BLE transition recorded; > 30 min unconnected raises alert.eld_disconnected.

```json
{
  "bleState": "CONNECTED",
  "connectionType": "USB",
  "disconnectedAlert": false
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — DRIVER_CONTEXT_REQUIRED — ingest accepts a driver token only. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/ingest/device-status` ♻️ O'ZGARGAN

**Nima qiladi:** 🆕 Stored hodisalar soni, firmware va SDK TrackerInfo (productName, bleFirmware, imei, reportedVin, connectionType, busType, appPlatform). Javobda `model`, `vinMismatch`, `systemVars`, `configVersion`.

- **Auth:** `Authorization: Bearer <driver access token>`
- **Ekran:** `{'id': 'web/settings-eld-devices', 'title': 'Settings · ELD devices', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `IngestController_deviceStatus` · original: _Reports stored-event backlog, firmware and SDK TrackerInfo (§7.7); answers the system variables to apply._
- **Izoh (backend):** `productName` `PT40*` -> model PT40, `PT30*` -> PT30. `reportedVin` differing from the paired unit VIN -> `vinMismatch: true` (never blocks; `alert.device_vin_mismatch` once per new VIN). `systemVars` are the PT SDK SetSystemVar targets.

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `deviceSerial` | string | ha | 1–60 belgi |  |
| `storedEventsCount` | integer | ha | 0–100000 |  |
| `firmware` | string | yo'q | ≤ 20 belgi |  |
| `mainFirmware` | string | yo'q | ≤ 20 belgi |  |
| `bleFirmware` | string | yo'q | ≤ 20 belgi |  |
| `sdkVersion` | string | yo'q | ≤ 20 belgi |  |
| `productName` | string | yo'q | ≤ 40 belgi |  |
| `imei` | string | yo'q | ≤ 20 belgi |  |
| `reportedVin` | string | yo'q | ≤ 20 belgi |  |
| `connectionType` | `BLE` \| `USB` | yo'q |  |  |
| `busType` | string yoki integer | yo'q, null mumkin |  |  |
| `appPlatform` | `IOS` \| `ANDROID` | yo'q |  |  |
| `recordsLost` | boolean | yo'q | default `false` |  |
| `consecutiveTransferFailures` | integer | yo'q | 0–1000, default `0` |  |

So'rov misoli:

```json
{
  "deviceSerial": "PT30_A86E",
  "storedEventsCount": 12,
  "mainFirmware": "L108",
  "bleFirmware": "1.4.2",
  "sdkVersion": "6.11.1",
  "productName": "PT40-C",
  "imei": "356938035643809",
  "reportedVin": "1FUJGLDR7CLBP8834",
  "connectionType": "BLE",
  "busType": "J1939",
  "appPlatform": "ANDROID",
  "recordsLost": false,
  "consecutiveTransferFailures": 0
}
```

**Javob `200`:** Backlog recorded; > 100 stored events raises alert.device_backlog.

```json
{
  "storedEventsCount": 12,
  "backlogAlert": false,
  "codes": [],
  "model": "PT40",
  "vinMismatch": false,
  "systemVars": {
    "PERIODIC_EVENT_GAP": 30,
    "PERIODIC_EVENT_GAP_NOBLE": 30,
    "EVENTS_STORED": 1,
    "DRIVING_ACCL": 0,
    "DRIVING_BRAKING": 450,
    "DRIVING_CORNERING": 0,
    "HSI_MODE": 1
  },
  "configVersion": "3f9a1c0b7d2e"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — DRIVER_CONTEXT_REQUIRED — ingest accepts a driver token only. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-unidentified"></a>

## Unidentified driving

### `POST /api/unidentified/{id}/confirm`

**Nima qiladi:** Haydovchi "bu siz edingizmi?" savoliga javob beradi (§7.4). Qabul qilinsa yozuvlar unga biriktiriladi (recordOrigin = 1).

- **Auth:** `Authorization: Bearer <driver access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`, `{'id': 'web/fleet-dashboard', 'title': 'Fleet Dashboard', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5'}`
- **operationId:** `UnidentifiedController_confirm` · original: _Driver answers "was this you?" (§7.4 rule 2). Accepting attributes the records with recordOrigin = 1 — never 2._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `accept` | boolean | ha |  |  |
| `annotation` | string | yo'q | 4–60 belgi |  |

**Javob `201`:** Accepting attributes the records to the driver with recordOrigin = 1 — never 2 (§23).

```json
{
  "id": "seg_1",
  "status": "ASSIGNED",
  "driverId": "drv_1",
  "recordOrigin": 1,
  "eventCount": 4
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Unidentified segment not found. · `409` UNIDENTIFIED_ALREADY_ASSIGNED — This segment is already assigned to a driver. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/unidentified/confirmation-requests`

**Nima qiladi:** Carrier shu haydovchidan tasdiqlashni so'ragan unidentified segmentlar (PENDING_CONFIRMATION).

- **Auth:** `Authorization: Bearer <driver access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`, `{'id': 'web/fleet-dashboard', 'title': 'Fleet Dashboard', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5'}`
- **operationId:** `UnidentifiedController_listConfirmationRequests` · original: _B-83 — driver app: segments a carrier asked THIS driver to confirm (status PENDING_CONFIRMATION). Answer with POST /unidentified/:id/confirm._

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "seg_1",
      "vehicleId": "veh_1",
      "status": "PENDING_CONFIRMATION",
      "assignedDriverId": "drv_1",
      "assignedById": "usr_1",
      "confirmationRequestedAt": "2026-09-11T15:41:00.000Z",
      "startAt": "2026-09-10T12:30:00.000Z",
      "endAt": "2026-09-10T13:00:00.000Z",
      "durationSec": 1800,
      "distanceMi": 21
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---
