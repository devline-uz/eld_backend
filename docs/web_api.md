# OneBook ELD — Web panel (back-office) API qo'llanmasi

Manba: `backend/docs/openapi.json` (generatsiya: 2026-10-10, backend `main`). Hujjat avtomatik yig'ilgan:
har bir endpoint uchun **nima qiladi**, auth, parametrlar, body maydonlari, javob misoli va xatolar.
Web panel chaqiradigan barcha endpointlar (haydovchi ilovasiga xos `/api/mobile/*`, `/api/ingest/*` va
haydovchi-only route'lar bundan tashqari).

PT SDK 6.11.1 bo'yicha web o'zgarishlari tafsiloti: `backend/docs/pt-sdk-6.11-web.md`.

Jami: **205 ta endpoint**, 37 bo'lim.


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
| `GET /api/devices`, `GET /api/devices/{id}` | ♻️ | TrackerInfo maydonlari (productName, bleFirmware, imei, reportedVin, sdkVersion, appPlatform, connectionType, busType, lastInfoAt), harsh/NOBLE sozlamalari, `systemVars` |
| `POST /api/devices`, `PATCH /api/devices/{id}`, `POST /api/devices/import` | ♻️ | `periodicNoBleSec` 10–480 s, `harshAccelMg`/`harshBrakeMg`/`harshCornerMg` 0–8192 mG |
| `GET /api/vehicles/{id}/dtc` | ♻️ | `code`, `bus`, `milOn`, `conversionMethod`, `active` — OBD-II/J1708 da `spn` null |
| `GET /api/vehicles/{id}/histories`, `GET /api/vehicles/{id}/telemetry` | ♻️ | lat/lon `null` bo'lishi mumkin; yangi VDB ustunlari |
| `GET /api/live/fleet` | ♻️ | Shakl o'zgarmagan; pin oxirgi GPS fix'li nuqtadan |
| `GET /api/safety/events` | ♻️ | Qurilma akselerometri harsh hodisalari ham keladi |
| `GET /api/notifications` | ♻️ | Yangi tur `alert.device_vin_mismatch` |


## Mundarija

- [Health (tizim holati)](#bolim-health) — 3 ta
  - `GET /health/live` — Jarayon tirikligini tekshiradi (liveness). Process ishlab tursa doim javob beradi.
  - `GET /health/ready` — Tayyorlikni tekshiradi (readiness): baza javob bersagina instansiya trafik qabul qiladi.
  - `GET /health/deep` — Chuqur tekshiruv: baza, Redis va object storage parallel tekshiriladi.
- [Autentifikatsiya](#bolim-auth) — 8 ta
  - `POST /api/auth/login` — Back-office foydalanuvchisi (web) email + parol bilan kiradi; access + refresh token qaytaradi.
  - `POST /api/auth/google` — Firebase orqali Google Sign-In. Avtomatik ro'yxatdan o'tkazmaydi — foydalanuvchi oldindan taklif qilingan bo'l
  - `POST /api/auth/refresh` — Refresh token'ni almashtiradi (har ishlatilganda yangisi beriladi, eskisi bekor bo'ladi).
  - `POST /api/auth/logout` — Berilgan refresh token sessiyasini bekor qiladi (chiqish).
  - `POST /api/auth/password/forgot` — Parolni tiklash tokenini so'raydi. Doim 200 (foydalanuvchi bor-yo'qligi oshkor qilinmaydi).
  - `POST /api/auth/password/reset` — /auth/password/forgot dan kelgan token bilan yangi parol o'rnatadi.
  - `POST /api/auth/email/verify` — `PATCH /users/:id { email }` dan keyingi email o'zgarishini tasdiqlaydi.
  - `GET /api/auth/me` — Joriy autentifikatsiyalangan subyekt (token claim'lari) + web topbar maydonlari.
- [Kompaniya (carrier)](#bolim-carrier) — 3 ta
  - `GET /api/carrier` — Kompaniya (carrier) profilini oladi — bitta qator.
  - `PATCH /api/carrier` — Kompaniya profilini yangilaydi (Settings → Company).
  - `GET /api/carrier/transfer-config` — eRODS transfer sozlamalari: timezone, Appendix A identifikatorlari, TEST/PRODUCTION rejimi (faqat o'qish).
- [Biriktirmalar](#bolim-attachments) — 1 ta
  - `GET /api/attachments/{id}/presign` — Bitta biriktirma (rasm/fayl) uchun 15 daqiqalik presigned GET URL; DVIR/defekt/tiket bo'yicha ruxsat tekshiril
- [Rollar](#bolim-roles) — 5 ta
  - `GET /api/roles` — Barcha rollarni ro'yxatlaydi (4 ta tizim roli bilan).
  - `POST /api/roles` — 22 kalitli ruxsat matritsasi bilan yangi custom rol yaratadi.
  - `GET /api/roles/{id}` — Bitta rolni oladi.
  - `PATCH /api/roles/{id}` — Custom rolni tahrirlaydi. ADMIN (tizim roli) o'zgartirilmaydi.
  - `DELETE /api/roles/{id}` — Custom rolni o'chiradi. ADMIN o'chirilmaydi.
- [Foydalanuvchilar](#bolim-users) — 6 ta
  - `GET /api/users` — Back-office foydalanuvchilarini roli bilan ro'yxatlaydi.
  - `POST /api/users` — Yangi back-office foydalanuvchini taklif qiladi (audit qilinadi).
  - `GET /api/users/{id}` — Bitta foydalanuvchini oladi.
  - `PATCH /api/users/{id}` — Foydalanuvchini tahrirlaydi, rolini ham (rol o'zgarishi audit qilinadi).
  - `DELETE /api/users/{id}` — Back-office foydalanuvchisini o'chiradi.
  - `POST /api/users/{id}/resend-invite` — INVITED holatidagi foydalanuvchiga taklif emailini qayta yuboradi va 7 kunlik muddatni yangilaydi.
- [Mening profilim (/me)](#bolim-me) — 9 ta
  - `GET /api/me/profile` — Joriy foydalanuvchi profili.
  - `PATCH /api/me/profile` — Joriy profilni yangilaydi (faqat ism/telefon, rol emas).
  - `GET /api/me/sessions` — Joriy foydalanuvchining faol sessiyalari.
  - `DELETE /api/me/sessions` — Boshqa barcha sessiyalardan chiqaradi ("Sign out everywhere").
  - `DELETE /api/me/sessions/{id}` — Bitta sessiyani bekor qiladi.
  - `POST /api/me/avatar` — Profil avatarini yuklaydi (PNG/JPG, kamida 256x256).
  - `DELETE /api/me/avatar` — Profil avatarini o'chiradi.
  - `GET /api/me/preferences` — UI sozlamalari: til, timezone, saqlangan view'lar, jadval ustunlari.
  - `PUT /api/me/preferences` — UI sozlamalarini to'liq almashtiradi.
- [Audit log](#bolim-audit-log) — 1 ta
  - `GET /api/audit-log` — Audit log yozuvlari, eng yangisi birinchi, cursor pagination.
- [API kalitlari](#bolim-api-keys) — 4 ta
  - `GET /api/api-keys` — API kalitlari ro'yxati — ochiq kalit yoki to'liq hash hech qachon qaytmaydi.
  - `POST /api/api-keys` — API kalit yaratadi. Ochiq kalit faqat bir marta qaytariladi.
  - `PATCH /api/api-keys/{id}/scopes` — Mavjud API kalitining scope'larini o'zgartiradi.
  - `DELETE /api/api-keys/{id}` — API kalitini darhol bekor qiladi.
- [Haydovchilar](#bolim-drivers) — 15 ta
  - `GET /api/drivers` — Haydovchilar ro'yxati: CDL, istisnolar, holat.
  - `POST /api/drivers` — Haydovchi yaratadi (CDL, home terminal timezone, HOS ruleset, istisno bayroqlari).
  - `GET /api/drivers/export` — Barcha haydovchilarni `POST /drivers/import` qabul qiladigan formatda eksport qiladi (parolsiz).
  - `GET /api/drivers/roster` — W-06 roster: har haydovchi uchun HOS soatlari, joriy duty status, unit va ochiq violation soni.
  - `GET /api/drivers/{id}/hos` — Bitta haydovchining 4 ta HOS soati, HOS engine hozir hisoblaydi.
  - `GET /api/drivers/{id}` — Bitta haydovchi profili.
  - `PATCH /api/drivers/{id}` — Haydovchi profili, CDL yoki istisno bayroqlarini yangilaydi.
  - `DELETE /api/drivers/{id}` — Haydovchini soft-delete qiladi (TERMINATED, unit ajratiladi). Hech qachon to'liq o'chirmaydi.
  - `POST /api/drivers/import` — Haydovchilarni ommaviy import qiladi; `username` bo'yicha upsert.
  - `POST /api/drivers/{id}/reset-password` — Dispetcher tomonidan haydovchi ilova parolini tiklash (email yoki og'zaki aytiladigan bir martalik kod). Audit
  - `POST /api/drivers/{id}/send-verification` — `Driver.email` ni tasdiqlash tokenini emailga yuboradi.
  - `POST /api/drivers/{id}/verify-email` — `send-verification` tokenini tasdiqlaydi; `emailVerifiedAt` o'rnatiladi.
  - `GET /api/drivers/{id}/documents` — Haydovchi hujjatlari ro'yxati (CDL skani, medical card va h.k.).
  - `POST /api/drivers/{id}/documents` — Hujjat metadata'sini yozadi va fayl yuklash uchun presigned PUT URL qaytaradi.
  - `DELETE /api/drivers/{id}/documents/{docId}` — Haydovchi hujjatini o'chiradi (storage obyekti va qator).
- [eRODS transferlar](#bolim-transfers) — 4 ta
  - `POST /api/transfers` — eRODS transfer so'raydi: §395 Appendix A output faylini yaratadi, tekshiradi, saqlaydi va yuborishni navbatga 
  - `GET /api/transfers` — Transferlar tarixi. `TEST_ONLY` — yaratilgan, lekin yuborilmagan fayllar.
  - `GET /api/transfers/{id}` — Bitta transfer yozuvi.
  - `GET /api/transfers/{id}/download` — Yaratilgan Appendix A faylini rasmiy fayl nomi bilan yuklab beradi (TEST rejimda ham ishlaydi).
- [Unitlar (vehicles)](#bolim-vehicles) — 14 ta
  - `GET /api/vehicles` — Unitlar ro'yxati — unit raqami, VIN, odometr, holat.
  - `POST /api/vehicles` — Unit qo'shadi (VIN, qo'shilgan paytdagi dashboard odometri).
  - `GET /api/vehicles/export` — Barcha unitlarni `POST /vehicles/import` formatida eksport qiladi.
  - `GET /api/vehicles/{id}` — Bitta unit (Unit detail ekrani).
  - `PATCH /api/vehicles/{id}` — Unitni tahrirlaydi.
  - `DELETE /api/vehicles/{id}` — Unitni soft-delete qiladi (INACTIVE, haydovchi ajratiladi).
  - `GET /api/vehicles/{id}/activities` — "Unit activity" lentasi: audit yozuvlari + shu unit DVIR'lari.
  - `GET /api/vehicles/{id}/histories` ♻️ — W-05 Unit histories: server tomonda kunni DRIVE/STOP/IDLE segmentlarga ajratadi. 🆕 lat/lon endi `null` bo'lish
  - `GET /api/vehicles/{id}/telemetry` ♻️ — Unitning oxirgi telemetriya nuqtalari (Virtual Dashboard), eng yangisi birinchi. 🆕 lat/lon `null` bo'lishi mum
  - `POST /api/vehicles/import` — Unitlarni ommaviy import qiladi; `unitNumber`/`vin` bo'yicha upsert.
  - `PATCH /api/vehicles/bulk-status` — Ko'p unitning `status`ini bitta so'rovda o'zgartiradi; har qatorga OOS qoidasi alohida qo'llanadi.
  - `POST /api/vehicles/{id}/calibrate-odometer` — PT30 ko'rsatkichiga nisbatan odometr offsetini qayta kalibrlaydi. Audit qilinadi.
  - `POST /api/vehicles/{id}/assign-driver` — Unitga haydovchi biriktiradi. Unit OUT_OF_SERVICE bo'lsa bloklanadi.
  - `POST /api/vehicles/{id}/unassign-driver` — Unitdagi joriy haydovchini ajratadi.
- [Treylerlar](#bolim-trailers) — 7 ta
  - `GET /api/trailers` — Treylerlar ro'yxati (o'chirilmaganlar), sahifalangan.
  - `POST /api/trailers` — Treyler qo'shadi.
  - `GET /api/trailers/export` — Treylerlarni `POST /trailers/import` formatida eksport qiladi.
  - `GET /api/trailers/{id}` — Bitta treyler (o'chirilgan bo'lsa 404).
  - `PATCH /api/trailers/{id}` — Treylerni tahrirlaydi.
  - `DELETE /api/trailers/{id}` — Treylerni soft-delete qiladi: ro'yxatdan yashiriladi, raqami bo'shaydi, eski DVIR/trip'lar uni ko'rsataveradi.
  - `POST /api/trailers/import` — Treylerlarni ommaviy import qiladi; `number` bo'yicha upsert.
- [Unit guruhlari](#bolim-vehicle-groups) — 6 ta
  - `GET /api/vehicle-groups` — Unit guruhlari ro'yxati, unit sonlari bilan.
  - `POST /api/vehicle-groups` — Unit guruhi yaratadi; ixtiyoriy `vehicleIds` shu unitlarni guruhga o'tkazadi.
  - `GET /api/vehicle-groups/{id}` — Bitta guruh, unitlari bilan.
  - `PATCH /api/vehicle-groups/{id}` — Guruh nomi/rangini o'zgartiradi.
  - `DELETE /api/vehicle-groups/{id}` — Guruhni o'chiradi; unitlar guruhsiz qoladi.
  - `PUT /api/vehicle-groups/{id}/vehicles` — Guruh a'zolarini aynan `vehicleIds` bilan almashtiradi.
- [Alert qoidalari](#bolim-alert-rules) — 6 ta
  - `GET /api/alert-rules` — Alert qoidalari ro'yxati (kanallar, throttle, quiet hours, qabul qiluvchilar).
  - `POST /api/alert-rules` — Custom alert qoidasi yaratadi. `channels: ["SMS"]` rad etiladi (v2 da).
  - `GET /api/alert-rules/{id}` — Bitta alert qoidasi.
  - `PATCH /api/alert-rules/{id}` — Alert qoidasini yangilaydi (kanallar, throttle, quiet hours, qabul qiluvchilar, yoqilgan/o'chiq).
  - `DELETE /api/alert-rules/{id}` — Custom alert qoidasini o'chiradi (tizim qoidalari o'chirilmaydi).
  - `POST /api/alert-rules/{id}/test` — Qoidaning o'z kanallari orqali chaqiruvchiga test bildirishnoma yuboradi.
- [Bildirishnomalar](#bolim-notifications) — 3 ta
  - `GET /api/notifications` ♻️ — Chaqiruvchining in-app bildirishnomalari, segment sonlari bilan. 🆕 yangi tur: `alert.device_vin_mismatch`.
  - `POST /api/notifications/read-all` — Barcha o'qilmagan bildirishnomalarni o'qilgan qiladi.
  - `POST /api/notifications/{id}/read` — Bitta bildirishnomani o'qilgan qiladi.
- [Bildirishnoma kanallari](#bolim-notification-channels) — 2 ta
  - `GET /api/notification-channels` — Tashkilot darajasidagi kanal sozlamalari (email, webhook).
  - `PATCH /api/notification-channels` — Kanal sozlamalarini yangilaydi. O'chirilgan kanal barcha alert qoidalari uchun yetkazishni to'xtatadi.
- [Integratsiyalar](#bolim-integrations) — 6 ta
  - `POST /api/integrations/webhook/test` — Sozlangan webhook manziliga imzolangan test hodisa yuboradi.
  - `GET /api/integrations` — Ulangan integratsiyalar ro'yxati. Maxfiy maydonlar yashiriladi.
  - `GET /api/integrations/catalog` — Integratsiyalar katalogi (Pacific Track, DAT, Geotab, Zapier va h.k.).
  - `GET /api/integrations/{provider}` — Bitta integratsiya (maxfiy maydonlar yashirin).
  - `PUT /api/integrations/{provider}` — Provayder ulanishini yaratadi yoki qayta sozlaydi; maxfiy qiymatlar shifrlanadi.
  - `DELETE /api/integrations/{provider}` — Provayderni uzadi va saqlangan sozlama/maxfiy qiymatlarni o'chiradi.
- [RODS loglar](#bolim-logs) — 7 ta
  - `GET /api/logs/{driverId}` — Bitta RODS kuni: grafik, yozuvlar, violation'lar, sertifikatsiya holati.
  - `GET /api/logs/{driverId}/range` — Kunlar oralig'i bo'yicha qisqa xulosalar (max 62 kun).
  - `GET /api/logs/{driverId}/events` — Kunning barcha §395 yozuvlari, almashtirilgan (2), taklif (3) va rad etilgan (4) lar bilan — inspektor ko'radi
  - `POST /api/logs/{driverId}/events` — YANGI yozuv taklif qiladi (recordStatus = 3, haydovchi qabul qilmaguncha hech narsaga ta'sir qilmaydi).
  - `GET /api/logs/{driverId}/edit-requests` — Carrier tahrir takliflari va haydovchi ularga qanday javob bergani.
  - `POST /api/logs/{driverId}/edit-requests` — Haydovchi yozuviga tahrir taklif qiladi (§395.30). Haydovchi qabul qilmaguncha hech narsa o'zgarmaydi.
  - `POST /api/logs/{driverId}/certify` — RODS kunlarini sertifikatlaydi. Back-office uchun `hosCertifyOnBehalf = FULL` kerak va audit qilinadi.
- [DTC (nosozlik kodlari)](#bolim-dtc) — 1 ta
  - `GET /api/vehicles/{id}/dtc` ♻️ — Unit nosozlik kodlari (DTC), default faqat ochiqlari. 🆕 qatorda `code`, `bus`, `milOn`, `conversionMethod`, `a
- [Xabarlar](#bolim-messaging) — 6 ta
  - `GET /api/conversations` — Chaqiruvchining suhbatlari.
  - `POST /api/conversations` — Berilgan ishtirokchilar bilan shaxsiy yoki guruh suhbati ochadi.
  - `GET /api/conversations/{id}/messages` — Suhbatdagi xabarlar (chaqiruvchi ishtirokchi bo'lishi shart).
  - `POST /api/conversations/{id}/messages` — Suhbatga xabar yuboradi.
  - `POST /api/conversations/{id}/read` — Chaqiruvchi uchun suhbatni hozirgacha o'qilgan qiladi.
  - `POST /api/messages/broadcast` — Bitta xabarni ko'p haydovchiga yuboradi (har haydovchiga alohida suhbat).
- [ELD qurilmalar](#bolim-devices) — 12 ta
  - `GET /api/devices` ♻️ — PT30/PT40 qurilmalar ro'yxati: BLE holati, firmware. 🆕 SDK TrackerInfo maydonlari (productName, bleFirmware, i
  - `POST /api/devices` ♻️ — PT30/PT40 qurilmani ro'yxatga oladi. 🆕 ixtiyoriy `periodicNoBleSec` 10–480 s, `harshAccelMg`/`harshBrakeMg`/`h
  - `GET /api/devices/export` — Barcha qurilmalarni `POST /devices/import` formatida eksport qiladi.
  - `GET /api/devices/{id}` ♻️ — Bitta qurilma. 🆕 yangi TrackerInfo maydonlari va `systemVars` bilan.
  - `PATCH /api/devices/{id}` ♻️ — Qurilmani tahrirlaydi (BLE MAC, periodik sozlamalar, holat). 🆕 `periodicNoBleSec`, `harshAccelMg`, `harshBrake
  - `DELETE /api/devices/{id}` — Qurilmani iste'moldan chiqaradi (RETIRED, ajratiladi). To'liq o'chirmaydi.
  - `GET /api/devices/{id}/diagnostics` — Qurilmaning oxirgi ulanish/GPS diagnostikasi (yozilgan holatdan, jonli so'rov emas).
  - `POST /api/devices/import` ♻️ — Qurilmalarni ommaviy import qiladi; `serial` bo'yicha upsert. 🆕 yangi sozlama maydonlari qabul qilinadi.
  - `PATCH /api/devices/{id}/firmware` — Qurilma xabar qilgan firmware versiyasini yozadi (L108 dan past bo'lsa ogohlantiradi).
  - `PATCH /api/devices/{id}/ble-status` — Back-office tomonidan BLE holatini qo'lda o'zgartirish (ilova o'zi /ingest/ble-state orqali yuboradi).
  - `POST /api/devices/{id}/pair` — Qurilmani unitga juftlaydi. Bitta unitga bitta qurilma.
  - `POST /api/devices/{id}/unpair` — Qurilmani unitdan ajratadi.
- [Co-driver juftliklari](#bolim-co-driver-pairings) — 3 ta
  - `GET /api/co-driver-pairings` — Co-driver juftliklari ro'yxati (unit yoki haydovchi bo'yicha, faqat faollar).
  - `POST /api/co-driver-pairings` — Unitda co-driver juftligini boshlaydi (team driving).
  - `POST /api/co-driver-pairings/{id}/end` — Faol co-driver juftligini tugatadi.
- [Unidentified driving](#bolim-unidentified) — 5 ta
  - `GET /api/unidentified` — Unidentified driving segmentlari ro'yxati.
  - `GET /api/unidentified/{id}` — Bitta segment va uning ortidagi §395 yozuvlari.
  - `POST /api/unidentified/{id}/assign` — Segmentni haydovchiga biriktiradi (ASSIGNED, audit). `requireDriverConfirmation` bilan haydovchi tasdig'i so'r
  - `POST /api/unidentified/{id}/annotate` — Segmentga izoh qo'shadi (max 60 belgi).
  - `POST /api/unidentified/{id}/reject` — Biriktirishni rad etadi: yozuvlar pool'ga qaytadi (recordOrigin = 4, driverId = null). Hech narsa o'chirilmayd
- [HOS violation'lar](#bolim-violations) — 2 ta
  - `GET /api/violations` — Flot HOS violation'lari (default status=OPEN), haydovchi ismi va unit bilan.
  - `POST /api/violations/{id}/resolve` — OPEN violation'ni 4–60 belgilik izoh bilan yopadi. Audit qilinadi; RODS yozuvlari o'zgarmaydi.
- [DVIR](#bolim-dvir) — 6 ta
  - `GET /api/dvir` — Topshirilgan DVIR'lar ro'yxati.
  - `GET /api/dvir/compliance` — Sana oralig'ida kutilgan va topshirilgan PRE_TRIP DVIR'lar (W-14 compliance).
  - `GET /api/dvir/{id}` — Bitta DVIR, defektlari va rasmlari bilan.
  - `GET /api/dvir/{id}/pdf` — Bitta DVIR'ni §396.11 PDF qilib beradi.
  - `POST /api/dvir/{id}/mechanic-signoff` — DVIR defektlari bo'yicha mexanik ko'rigini yozadi (§396.13).
  - `PATCH /api/dvir/{id}/next-driver-review` — Keyingi haydovchi oldingi DVIR mexanik xulosasini ko'rganini belgilaydi (§396.13).
- [Defektlar](#bolim-defects) — 5 ta
  - `GET /api/defects` — DVIR'lardan kelgan defektlar ro'yxati.
  - `GET /api/defects/{id}` — Bitta defekt.
  - `PATCH /api/defects/{id}/resolve` — Defektni yopadi (REPAIRED/NOT_REQUIRED/DEFERRED + ta'mir ma'lumotlari). Oxirgi ochiq defekt bo'lsa unit OUT_OF
  - `PATCH /api/defects/{id}/assign` — Defekt mas'ulini/ustaxonani belgilaydi yoki tozalaydi.
  - `PATCH /api/defects/{id}/work-order` — Defektni work order'ga biriktiradi yoki ajratadi.
- [Work order'lar](#bolim-work-orders) — 7 ta
  - `GET /api/work-orders` — Work order'lar ro'yxati.
  - `POST /api/work-orders` — Work order yaratadi, ixtiyoriy ochiq defektlarni biriktiradi.
  - `GET /api/work-orders/{id}` — Bitta work order.
  - `PATCH /api/work-orders/{id}` — Work order'ni tahrirlaydi (sarlavha, prioritet, vendor, narx, muddat). DONE/CANCELLED bo'lgach bloklanadi.
  - `POST /api/work-orders/{id}/close` — Work order'ni yopadi (DONE). Barcha biriktirilgan defektlar yopilgan bo'lishi shart.
  - `POST /api/work-orders/{id}/cancel` — Work order'ni bekor qiladi.
  - `POST /api/work-orders/{id}/defects/{defectId}` — Ochiq defektni shu work order'ga biriktiradi.
- [Texnik xizmat](#bolim-maintenance) — 6 ta
  - `GET /api/maintenance-schedules` — Texnik xizmat jadvallari, hisoblangan muddat holati bilan.
  - `POST /api/maintenance-schedules` — Texnik xizmat jadvali yaratadi ("Brake service", "DOT annual inspection" va h.k.).
  - `GET /api/maintenance-schedules/{id}` — Bitta jadval, muddat holati bilan.
  - `PATCH /api/maintenance-schedules/{id}` — Jadvalni tahrirlaydi; `status` + `reviewNote` bilan haydovchi invoice'ini tasdiqlaydi (COMPLETED) yoki rad eta
  - `DELETE /api/maintenance-schedules/{id}` — Texnik xizmat jadvalini o'chiradi.
  - `POST /api/maintenance-schedules/{id}/complete` — Jadvalni hozir bajarilgan deb belgilaydi, interval qaytadan boshlanadi.
- [Support](#bolim-support) — 6 ta
  - `GET /api/support/tickets` — Support tiketlari ro'yxati.
  - `POST /api/support/tickets` — Support tiketi ochadi (support:READ yetarli).
  - `GET /api/support/tickets/{id}` — Bitta support tiketi.
  - `PATCH /api/support/tickets/{id}` — Tiketni yangilaydi (holat, prioritet, mas'ul).
  - `POST /api/support/chats` — Real-time support chat ochadi va birinchi xabarni yuboradi; javoblar `conversation:{id}` socket room'ida.
  - `POST /api/feedback` — In-app fikr-mulohaza yuboradi (support:READ yetarli).
- [Trip / dispatch](#bolim-trips) — 8 ta
  - `GET /api/trips` — Trip/yuklar ro'yxati, dispatch holati bilan.
  - `POST /api/trips` — Trip/yuk yaratadi, ixtiyoriy stoplar va boshlang'ich haydovchi/unit bilan.
  - `GET /api/trips/unassigned-loads` — Hali haydovchi biriktirilmagan yuklar (dispatch "unassigned" ustuni).
  - `GET /api/trips/{id}` — Bitta trip, stoplari bilan.
  - `PATCH /api/trips/{id}` — Trip maydonlarini yangilaydi yoki holatini oldinga suradi.
  - `DELETE /api/trips/{id}` — Tripni stoplari bilan butunlay o'chiradi (IN_PROGRESS o'chirilmaydi).
  - `POST /api/trips/{id}/assign` — Tripga haydovchi/unit/treyler biriktiradi yoki almashtiradi.
  - `POST /api/trips/auto-assign` — Biriktirilmagan har bir yukni navbatdagi bo'sh ACTIVE haydovchiga beradi.
- [Safety](#bolim-safety) — 4 ta
  - `GET /api/safety/events` ♻️ — Harsh-driving hodisalari ro'yxati. 🆕 qurilma akselerometri (EV_MEMS_*) dan kelgan HARSH_ACCEL/HARSH_BRAKING/HA
  - `PATCH /api/safety/events/{id}` — Safety hodisasini REVIEWED/DISMISSED qiladi.
  - `GET /api/safety/scorecard` — Flot safety bahosi va haydovchilar reytingi (70 dan pasti belgilanadi), oldingi davr bilan trend.
  - `POST /api/safety/coaching` — "Assign coaching": hodisani izoh bilan COACHED qilib yopadi, yoki `driverId` bilan haydovchi darajasida.
- [Geofence'lar](#bolim-geofences) — 5 ta
  - `GET /api/geofences` — Live Fleet xaritasidagi barcha geofence'lar.
  - `POST /api/geofences` — Yangi terminal/mijoz geofence'ini chizadi (doira yoki poligon); ixtiyoriy `vehicleGroupId`.
  - `GET /api/geofences/{id}` — Bitta geofence.
  - `PATCH /api/geofences/{id}` — Geofence'ni yangilaydi.
  - `DELETE /api/geofences/{id}` — Geofence'ni o'chiradi.
- [Qidiruv](#bolim-search) — 1 ta
  - `GET /api/search` — Command palette uchun global haydovchi + unit qidiruvi.
- [Live fleet](#bolim-live) — 1 ta
  - `GET /api/live/fleet` ♻️ — Har bir unitning joriy holati: oxirgi pozitsiya, tezlik, haydovchi, duty status, HOS soatlari, ELD aloqasi. 🆕 
- [Dashboard](#bolim-dashboard) — 1 ta
  - `GET /api/dashboard/summary` — W-01 Fleet Dashboard uchun bitta so'rovda: live fleet, 24 soatlik violation'lar, kutilayotgan unidentified, o'
- [Hisobotlar](#bolim-reports) — 16 ta
  - `POST /api/reports/generate` — Hisobot ishini navbatga qo'yadi. Sinxron emas — GET /reports/:id bilan so'rang yoki `report.ready` ni tinglang
  - `GET /api/reports` — Hisobot ishlari ro'yxati, eng yangisi birinchi.
  - `GET /api/reports/schedules` — Hisobot jadvallari (cron).
  - `POST /api/reports/schedules` — Hisobot jadvali yaratadi; `nextRunAt` cron/timezone'dan hisoblanadi.
  - `PATCH /api/reports/schedules/{id}` — Hisobot jadvalini yangilaydi (`enabled`, `cron` va h.k.).
  - `DELETE /api/reports/schedules/{id}` — Hisobot jadvalini o'chiradi; yaratilgan hisobotlar qoladi.
  - `GET /api/reports/ifta` — Chorak uchun IFTA hisobotini navbatga qo'yadi (`?format=PDF` → PDF).
  - `GET /api/reports/ifta/jurisdictions` — W-12 `Jurisdiction` menyusi uchun IFTA yurisdiksiyalari (AQSh, keyin Kanada).
  - `GET /api/reports/ifta/summary` — W-12 uchun JSON IFTA chorak xulosasi: yurisdiksiya jami, flot MPG, oldingi chorak bilan solishtirish.
  - `GET /api/reports/activity` — Sana oralig'i uchun activity hisobotini navbatga qo'yadi (`?format=PDF` → PDF).
  - `GET /api/reports/activity/summary` — W-13/W-15/dashboard uchun haydovchilar bo'yicha JSON activity agregati.
  - `GET /api/reports/dvir` — Sana oralig'i uchun DVIR hisobotini navbatga qo'yadi (`?format=PDF` → PDF).
  - `GET /api/reports/fmcsa-pack` — Sana oralig'i uchun FMCSA compliance paketini navbatga qo'yadi (har haydovchi Appendix A fayli + PDF muqova).
  - `GET /api/reports/{id}` — Hisobot ishi holati; READY bo'lsa 7 kunlik presigned yuklash URL'i.
  - `GET /api/reports/{id}/download` — READY hisobot uchun yangi presigned URL (7 kun). Tayyor bo'lmasa 409.
  - `GET /api/reports/{id}/file` — READY hisobot faylini API orqali yuklab beradi (`text/csv` yoki `application/pdf`). Web shuni ishlatadi.

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

### `GET /health/ready`

**Nima qiladi:** Tayyorlikni tekshiradi (readiness): baza javob bersagina instansiya trafik qabul qiladi.

- **Auth:** Ochiq (token kerak emas)
- **operationId:** `HealthController_ready` · original: _Readiness probe — the instance only takes traffic when the database answers._

**Javob `200`:** Database reachable; instance can take traffic.

```json
{
  "status": "ok",
  "info": {
    "database": {
      "status": "up"
    }
  },
  "details": {
    "database": {
      "status": "up"
    }
  }
}
```

**Xatolar:** `503` SERVICE_UNAVAILABLE — Database is not reachable.

---

### `GET /health/deep`

**Nima qiladi:** Chuqur tekshiruv: baza, Redis va object storage parallel tekshiriladi.

- **Auth:** Ochiq (token kerak emas)
- **operationId:** `HealthController_deep` · original: _Deep probe — database, Redis and object storage checked in parallel._

**Javob `200`:** Database, Redis and object storage checked in parallel.

```json
{
  "status": "ok",
  "checks": {
    "database": {
      "status": "up",
      "latencyMs": 3
    },
    "redis": {
      "status": "up",
      "latencyMs": 1
    },
    "storage": {
      "status": "up",
      "latencyMs": 12
    }
  }
}
```

**Xatolar:** `503` SERVICE_UNAVAILABLE — At least one dependency is down.

---

<a id="bolim-auth"></a>

## Autentifikatsiya

### `POST /api/auth/login`

**Nima qiladi:** Back-office foydalanuvchisi (web) email + parol bilan kiradi; access + refresh token qaytaradi.

- **Auth:** Ochiq (token kerak emas)
- **Ekran:** `{'id': 'web/sign-in', 'title': 'Sign in', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.3'}`
- **operationId:** `AuthController_login` · original: _Back-office password login (TZ §6.1)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `email` | string (email) | ha |  |  |
| `password` | string | ha | ≥ 1 belgi |  |

**Javob `200`:** Access+refresh tokens.

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "a1b2...",
  "tokenType": "Bearer"
}
```

**Xatolar:** `401` INVALID_CREDENTIALS — Email or password is incorrect. · `403` PASSWORD_LOGIN_DISABLED — AUTH_MODE=production — sign in with Google instead (B-25). · `422` VALIDATION_FAILED — Request validation failed. · `423` ACCOUNT_LOCKED — Too many failed attempts — the account is temporarily locked. · `429` RATE_LIMITED — Login is limited to 5 attempts per minute per IP (TZ §6.5).

---

### `POST /api/auth/google`

**Nima qiladi:** Firebase orqali Google Sign-In. Avtomatik ro'yxatdan o'tkazmaydi — foydalanuvchi oldindan taklif qilingan bo'lishi kerak.

- **Auth:** Ochiq (token kerak emas)
- **Ekran:** `{'id': 'web/sign-in', 'title': 'Sign in', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.3'}`
- **operationId:** `AuthController_google` · original: _Google Sign-In via Firebase (TZ §6.2). No auto-registration._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `idToken` | string | ha | ≥ 1 belgi |  |

**Javob `200`:** 

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "a1b2...",
  "tokenType": "Bearer"
}
```

**Xatolar:** `401` TOKEN_INVALID — The Firebase ID token could not be verified. · `403` USER_NOT_INVITED — Google Sign-In never auto-registers — the user must be invited first (TZ §6.2). · `422` VALIDATION_FAILED — Request validation failed.

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

### `POST /api/auth/password/reset`

**Nima qiladi:** /auth/password/forgot dan kelgan token bilan yangi parol o'rnatadi.

- **Auth:** Ochiq (token kerak emas)
- **Ekran:** `{'id': 'web/sign-in', 'title': 'Sign in', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.3'}`
- **operationId:** `AuthController_resetPassword` · original: _Completes a password reset with the token from /auth/password/forgot._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `token` | string | ha | ≥ 1 belgi |  |
| `newPassword` | string | ha | ≥ 8 belgi |  |

**Javob `200`:** 

```json
{
  "success": true
}
```

**Xatolar:** `401` TOKEN_EXPIRED — The reset link has expired — request a new one. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/auth/email/verify`

**Nima qiladi:** `PATCH /users/:id { email }` dan keyingi email o'zgarishini tasdiqlaydi.

- **Auth:** Ochiq (token kerak emas)
- **Ekran:** `{'id': 'web/sign-in', 'title': 'Sign in', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.3'}`
- **operationId:** `AuthController_verifyEmailChange` · original: _B-84 — completes a `PATCH /users/:id { email }` re-verification._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `token` | string | ha | ≥ 1 belgi |  |

**Javob `200`:** 

```json
{
  "success": true
}
```

**Xatolar:** `401` TOKEN_INVALID — The verification link is invalid or expired. · `409` CONFLICT — Another user already has this email. · `422` VALIDATION_FAILED — Request validation failed.

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

<a id="bolim-carrier"></a>

## Kompaniya (carrier)

### `GET /api/carrier`

**Nima qiladi:** Kompaniya (carrier) profilini oladi — bitta qator.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-company-profile', 'title': 'Settings · Company profile', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `CarrierController_get` · original: _Gets the single-row carrier/company profile (TZ §5.1)._

**Javob `200`:** 

```json
{
  "id": "carrier",
  "name": "Acme Trucking",
  "dotNumber": "1234567",
  "eldIdentifier": "OBK001",
  "erodsMode": "TEST"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/carrier`

**Nima qiladi:** Kompaniya profilini yangilaydi (Settings → Company).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-company-profile', 'title': 'Settings · Company profile', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `CarrierController_update` · original: _Updates the carrier/company profile (Settings screens)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `name` | string | yo'q | 1–200 belgi |  |
| `dotNumber` | string | yo'q | 1–20 belgi |  |
| `mcNumber` | string | yo'q | ≤ 20 belgi |  |
| `ein` | string | yo'q | ≤ 20 belgi |  |
| `timezone` | string | yo'q | 1–60 belgi |  |
| `hosRuleset` | `US_70_8_PROPERTY` \| `US_60_7_PROPERTY` \| `US_70_8_PASSENGER` \| `US_60_7_PASSENGER` | yo'q |  |  |
| `distanceUnit` | `MILES` \| `KILOMETERS` | yo'q |  |  |
| `cycleRestart` | boolean | yo'q |  |  |
| `unassignedThresholdMin` | integer | yo'q | 0–60 |  |
| `dvirRetentionMonths` | integer | yo'q | 1–120 |  |
| `allowPersonalConveyance` | boolean | yo'q |  |  |
| `allowYardMove` | boolean | yo'q |  |  |
| `addressLine1` | string | yo'q | ≤ 200 belgi |  |
| `city` | string | yo'q | ≤ 100 belgi |  |
| `state` | string | yo'q | ≤ 50 belgi |  |
| `zip` | string | yo'q | ≤ 20 belgi |  |
| `phone` | string | yo'q | ≤ 30 belgi |  |
| `complianceEmail` | string (email) | yo'q | ≤ 200 belgi |  |
| `logoUrl` | string | yo'q | ≤ 500 belgi |  |
| `eldIdentifier` | string | yo'q | pattern `^[A-Z0-9]{6}$` |  |
| `eldRegistrationId` | string | yo'q | pattern `^[A-Z0-9]{4}$` |  |
| `erodsMode` | `TEST` \| `PRODUCTION` | yo'q |  |  |

**Javob `200`:** 

```json
{
  "id": "carrier",
  "name": "Universal Logistics Inc.",
  "dotNumber": "1234567",
  "timezone": "America/New_York",
  "eldIdentifier": "OBK001",
  "eldRegistrationId": null,
  "erodsMode": "TEST"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — eldIdentifier must be exactly 6 characters (7.15), eldRegistrationId exactly 4 (7.17), from [A-Z0-9] (Appendix A).

---

### `GET /api/carrier/transfer-config`

**Nima qiladi:** eRODS transfer sozlamalari: timezone, Appendix A identifikatorlari, TEST/PRODUCTION rejimi (faqat o'qish).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/send-logs-to-safety-official', 'title': 'Send logs to a safety official', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.16'}`, `{'id': 'web/reports-fmcsa-audit-pack', 'title': 'Reports · FMCSA / DOT audit pack', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.21'}`
- **operationId:** `CarrierController_getTransferConfig` · original: _B-45 — eRODS transfer settings for the report/transfer screens: timezone, Appendix A identifiers and the TEST/PRODUCTION mode (read-only)._

**Javob `200`:** 

```json
{
  "timezone": "America/New_York",
  "eldIdentifier": "OBK001",
  "eldRegistrationId": null,
  "erodsMode": "TEST"
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

<a id="bolim-roles"></a>

## Rollar

### `GET /api/roles`

**Nima qiladi:** Barcha rollarni ro'yxatlaydi (4 ta tizim roli bilan).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-roles-permissions', 'title': 'Settings · Roles & permissions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.23'}`
- **operationId:** `RolesController_list` · original: _Lists all roles, including the 4 system roles._

**Javob `200`:** 

```json
[
  {
    "key": "ADMIN",
    "isSystem": true,
    "permissions": {},
    "userCount": 1
  }
]
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/roles`

**Nima qiladi:** 22 kalitli ruxsat matritsasi bilan yangi custom rol yaratadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-roles-permissions', 'title': 'Settings · Roles & permissions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.23'}`
- **operationId:** `RolesController_create` · original: _Creates a custom role with a full 22-key permission matrix._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `key` | string | ha | 2–40 belgi, pattern `^[A-Z][A-Z0-9_]*$` |  |
| `name` | string | ha | 1–80 belgi |  |
| `description` | string | yo'q | ≤ 500 belgi |  |
| `permissions` | object | ha |  |  |
| `permissions.dashboard` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.liveFleet` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.vehicles` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.drivers` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.hos` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.hosEdit` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.hosCertifyOnBehalf` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.dvir` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.maintenance` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.safety` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.trips` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.reports` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.reportsTransfer` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.messaging` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.devices` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.alertRules` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.users` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.roles` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.integrations` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.auditLog` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.support` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.carrierSettings` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.dataTransfer` | `NONE` \| `READ` \| `FULL` | ha |  |  |

**Javob `201`:** 

```json
{
  "id": "rol_9",
  "key": "SAFETY_REVIEWER",
  "name": "Safety reviewer",
  "isSystem": false,
  "permissions": {
    "logs": "READ",
    "safety": "FULL"
  }
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `409` CONFLICT — A role with this key already exists. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/roles/{id}`

**Nima qiladi:** Bitta rolni oladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-roles-permissions', 'title': 'Settings · Roles & permissions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.23'}`
- **operationId:** `RolesController_get` · original: _Gets one role by id._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "rol_1",
  "key": "DISPATCHER",
  "name": "Dispatcher",
  "isSystem": true,
  "permissions": {
    "vehicles": "READ",
    "drivers": "READ",
    "logs": "READ",
    "reportsTransfer": "NONE"
  }
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Role not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/roles/{id}`

**Nima qiladi:** Custom rolni tahrirlaydi. ADMIN (tizim roli) o'zgartirilmaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-roles-permissions', 'title': 'Settings · Roles & permissions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.23'}`
- **operationId:** `RolesController_update` · original: _Updates a custom role. ADMIN (isSystem) cannot be edited._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `name` | string | yo'q | 1–80 belgi |  |
| `description` | string | yo'q | ≤ 500 belgi |  |
| `permissions` | object | yo'q |  |  |
| `permissions.dashboard` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.liveFleet` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.vehicles` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.drivers` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.hos` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.hosEdit` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.hosCertifyOnBehalf` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.dvir` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.maintenance` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.safety` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.trips` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.reports` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.reportsTransfer` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.messaging` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.devices` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.alertRules` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.users` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.roles` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.integrations` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.auditLog` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.support` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.carrierSettings` | `NONE` \| `READ` \| `FULL` | ha |  |  |
| `permissions.dataTransfer` | `NONE` \| `READ` \| `FULL` | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "rol_9",
  "key": "SAFETY_REVIEWER",
  "name": "Safety reviewer",
  "isSystem": false,
  "permissions": {
    "logs": "READ",
    "safety": "READ"
  }
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Role not found. · `409` ROLE_IMMUTABLE — System roles cannot be edited or deleted (Figma: "Admin cannot be edited"). · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/roles/{id}`

**Nima qiladi:** Custom rolni o'chiradi. ADMIN o'chirilmaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-roles-permissions', 'title': 'Settings · Roles & permissions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.23'}`
- **operationId:** `RolesController_remove` · original: _Deletes a custom role. ADMIN (isSystem) cannot be deleted._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "success": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Role not found. · `409` ROLE_IMMUTABLE — System roles cannot be edited or deleted (Figma: "Admin cannot be edited"). · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-users"></a>

## Foydalanuvchilar

### `GET /api/users`

**Nima qiladi:** Back-office foydalanuvchilarini roli bilan ro'yxatlaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-users', 'title': 'Settings · Users', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22'}`
- **operationId:** `UsersController_list` · original: _Lists back-office users with their role._

**Javob `200`:** 

```json
[
  {
    "id": "usr_1",
    "email": "sarah.chen@universal-logistics.com",
    "firstName": "Sarah",
    "lastName": "Chen",
    "status": "ACTIVE",
    "role": {
      "key": "ADMIN",
      "name": "Administrator"
    },
    "lastActiveAt": "2026-09-11T15:39:00.000Z"
  }
]
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/users`

**Nima qiladi:** Yangi back-office foydalanuvchini taklif qiladi (audit qilinadi).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-users', 'title': 'Settings · Users', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22'}`
- **operationId:** `UsersController_create` · original: _Invites a new back-office user (TZ §18 — audited)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `email` | string (email) | ha |  |  |
| `firstName` | string | ha | 1–80 belgi |  |
| `lastName` | string | ha | 1–80 belgi |  |
| `jobTitle` | string | yo'q | ≤ 120 belgi |  |
| `phone` | string | yo'q |  |  |
| `roleId` | string (uuid) | ha |  |  |
| `terminalIds` | string[] | yo'q | ≤ 50 ta |  |
| `message` | string | yo'q | ≤ 500 belgi |  |

**Javob `200`:** 

```json
{
  "user": {
    "id": "usr_1",
    "status": "INVITED"
  },
  "emailDelivered": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `409` CONFLICT — A user with this email already exists. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/users/{id}`

**Nima qiladi:** Bitta foydalanuvchini oladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-users', 'title': 'Settings · Users', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22'}`
- **operationId:** `UsersController_get` · original: _Gets one back-office user._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "usr_1",
  "email": "sarah.chen@universal-logistics.com",
  "firstName": "Sarah",
  "lastName": "Chen",
  "status": "ACTIVE",
  "role": {
    "key": "ADMIN",
    "name": "Administrator"
  }
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — User not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/users/{id}`

**Nima qiladi:** Foydalanuvchini tahrirlaydi, rolini ham (rol o'zgarishi audit qilinadi).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-users', 'title': 'Settings · Users', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22'}`
- **operationId:** `UsersController_update` · original: _Updates a user, including role assignment (TZ §18 — audited as a role change)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `firstName` | string | yo'q | 1–80 belgi |  |
| `lastName` | string | yo'q | 1–80 belgi |  |
| `jobTitle` | string | yo'q | ≤ 120 belgi |  |
| `phone` | string | yo'q |  |  |
| `roleId` | string (uuid) | yo'q |  |  |
| `status` | `INVITED` \| `ACTIVE` \| `DISABLED` | yo'q |  |  |
| `email` | string (email) | yo'q |  |  |
| `homeTerminalName` | string | yo'q | ≤ 120 belgi |  |

**Javob `200`:** 

```json
{
  "id": "usr_3",
  "firstName": "Dana",
  "lastName": "Ford",
  "status": "ACTIVE",
  "role": {
    "key": "DISPATCHER",
    "name": "Dispatcher"
  }
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — User not found. · `409` ROLE_IMMUTABLE — The ADMIN system role cannot be reassigned away from the last administrator. · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/users/{id}`

**Nima qiladi:** Back-office foydalanuvchisini o'chiradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-users', 'title': 'Settings · Users', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22'}`
- **operationId:** `UsersController_remove` · original: _Deletes a back-office user._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "success": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — User not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/users/{id}/resend-invite`

**Nima qiladi:** INVITED holatidagi foydalanuvchiga taklif emailini qayta yuboradi va 7 kunlik muddatni yangilaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-users', 'title': 'Settings · Users', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22'}`
- **operationId:** `UsersController_resendInvite` · original: _Re-sends the invite email and restarts the 7-day window for a user still in INVITED status._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `201`:** 

```json
{
  "emailDelivered": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — User not found. · `409` CONFLICT — User is not in INVITED status. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-me"></a>

## Mening profilim (/me)

### `GET /api/me/profile`

**Nima qiladi:** Joriy foydalanuvchi profili.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/my-profile', 'title': 'My profile · Active sessions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.4'}`
- **operationId:** `MeController_profile` · original: _The current user profile._

**Javob `200`:** 

```json
{
  "id": "usr_1",
  "email": "sarah.chen@universal-logistics.com",
  "firstName": "Sarah",
  "lastName": "Chen",
  "phone": "+13347654888",
  "role": {
    "key": "ADMIN",
    "name": "Administrator"
  }
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/me/profile`

**Nima qiladi:** Joriy profilni yangilaydi (faqat ism/telefon, rol emas).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/my-profile', 'title': 'My profile · Active sessions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.4'}`
- **operationId:** `MeController_updateProfile` · original: _Updates the current user profile (name/phone only — not role)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `firstName` | string | yo'q | 1–80 belgi |  |
| `lastName` | string | yo'q | 1–80 belgi |  |
| `jobTitle` | string | yo'q | ≤ 120 belgi |  |
| `phone` | string | yo'q |  |  |

**Javob `200`:** 

```json
{
  "id": "usr_1",
  "firstName": "Sarah",
  "lastName": "Chen",
  "phone": "+13347654999"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/me/sessions`

**Nima qiladi:** Joriy foydalanuvchining faol sessiyalari.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/my-profile', 'title': 'My profile · Active sessions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.4'}`
- **operationId:** `MeController_sessions` · original: _Lists the current user's active sessions (B-50 — no refreshHash/userId ever leaves this endpoint)._

**Javob `200`:** Active sessions — the "My profile → Active sessions" panel.

```json
[
  {
    "id": "ses_1",
    "deviceLabel": null,
    "ip": "10.14.2.88",
    "userAgent": "Chrome/140 macOS",
    "location": null,
    "lastSeenAt": "2026-09-11T15:39:00.000Z",
    "current": true
  }
]
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/me/sessions`

**Nima qiladi:** Boshqa barcha sessiyalardan chiqaradi ("Sign out everywhere").

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/my-profile', 'title': 'My profile · Active sessions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.4'}`
- **operationId:** `MeController_revokeAllSessions` · original: _Signs the current user out of every other active session ("Sign out everywhere", B-50)._

**Javob `200`:** 

```json
{
  "revoked": 3
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/me/sessions/{id}`

**Nima qiladi:** Bitta sessiyani bekor qiladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/my-profile', 'title': 'My profile · Active sessions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.4'}`
- **operationId:** `MeController_revokeSession` · original: _Revokes one of the current user's sessions._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "success": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Session not found for this user. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/me/avatar`

**Nima qiladi:** Profil avatarini yuklaydi (PNG/JPG, kamida 256x256).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/my-profile', 'title': 'My profile · Active sessions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.4'}`
- **operationId:** `MeController_uploadAvatar` · original: _B-51 — uploads the profile avatar (PNG/JPG, >= 256x256)._

**Body** (`multipart/form-data`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `file` | string | yo'q |  |  |

**Javob `200`:** 

```json
{
  "id": "usr_1",
  "avatarUrl": "https://minio.local/onebook-eld/avatars/usr_1/..."
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` FILE_TOO_LARGE — Avatar exceeds the upload size limit.

---

### `DELETE /api/me/avatar`

**Nima qiladi:** Profil avatarini o'chiradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/my-profile', 'title': 'My profile · Active sessions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.4'}`
- **operationId:** `MeController_deleteAvatar` · original: _B-51 — removes the profile avatar._

**Javob `200`:** 

```json
{
  "id": "usr_1",
  "avatarUrl": null
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/me/preferences`

**Nima qiladi:** UI sozlamalari: til, timezone, saqlangan view'lar, jadval ustunlari.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/my-profile', 'title': 'My profile · Active sessions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.4'}`
- **operationId:** `MeController_getPreferences` · original: _B-11 — the current user's UI preferences (language, timezone, saved views, table columns)._

**Javob `200`:** 

```json
{
  "language": "en",
  "timezone": "America/Chicago",
  "dateFormat": "MMM D, YYYY",
  "distanceUnit": "MILES",
  "savedViews": {},
  "tableColumns": {}
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PUT /api/me/preferences`

**Nima qiladi:** UI sozlamalarini to'liq almashtiradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/my-profile', 'title': 'My profile · Active sessions', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.4'}`
- **operationId:** `MeController_updatePreferences` · original: _B-11 — replaces the current user's UI preferences._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `language` | string | yo'q | ≤ 20 belgi |  |
| `timezone` | string | yo'q | ≤ 60 belgi |  |
| `dateFormat` | string | yo'q | ≤ 30 belgi |  |
| `distanceUnit` | `MILES` \| `KM` | yo'q |  |  |
| `savedViews` | object | yo'q |  |  |
| `tableColumns` | object | yo'q |  |  |

**Javob `200`:** 

```json
{
  "language": "en",
  "timezone": "America/Chicago",
  "dateFormat": "MMM D, YYYY",
  "distanceUnit": "MILES"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-audit-log"></a>

## Audit log

### `GET /api/audit-log`

**Nima qiladi:** Audit log yozuvlari, eng yangisi birinchi, cursor pagination.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-audit-log', 'title': 'Settings · Audit log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.25'}`
- **operationId:** `AuditController_list` · original: _Lists audit log entries, newest first, cursor-paginated (TZ §19)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `objectType` | query | string | yo'q |  |  |
| `objectId` | query | string | yo'q |  |  |
| `actorId` | query | string | yo'q |  |  |
| `limit` | query | string | yo'q |  |  |
| `cursor` | query | string | yo'q |  |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "42",
      "actorType": "USER",
      "actorName": "Sarah Chen",
      "actorEmail": "sarah.chen@universal-logistics.com",
      "action": "UPDATE",
      "objectType": "Role",
      "objectId": "role_1"
    }
  ],
  "nextCursor": null
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-api-keys"></a>

## API kalitlari

### `GET /api/api-keys`

**Nima qiladi:** API kalitlari ro'yxati — ochiq kalit yoki to'liq hash hech qachon qaytmaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-integrations', 'title': 'Settings · Integrations', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `ApiKeysController_list` · original: _Lists API keys — never returns the plaintext key or full hash._

**Javob `200`:** 

```json
[
  {
    "id": "key_1",
    "name": "McLeod TMS",
    "prefix": "obk_ABCD",
    "scopes": [
      "logs:read",
      "vehicles:read"
    ],
    "lastUsedAt": "2026-09-11T14:02:00.000Z",
    "expiresAt": null,
    "revokedAt": null
  }
]
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/api-keys`

**Nima qiladi:** API kalit yaratadi. Ochiq kalit faqat bir marta qaytariladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-integrations', 'title': 'Settings · Integrations', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `ApiKeysController_create` · original: _Creates an API key. The plaintext key is returned exactly once._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `name` | string | ha | 1–80 belgi |  |
| `scopes` | string[] | ha | ≥ 1 ta |  |
| `expiresAt` | string (date-time) | yo'q |  |  |

**Javob `200`:** 

```json
{
  "apiKey": {
    "id": "key_1",
    "prefix": "obk_ABCD"
  },
  "plaintextKey": "obk_...(shown once)"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/api-keys/{id}/scopes`

**Nima qiladi:** Mavjud API kalitining scope'larini o'zgartiradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-integrations', 'title': 'Settings · Integrations', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `ApiKeysController_updateScopes` · original: _Changes the scopes granted to an existing API key._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `scopes` | string[] | ha | ≥ 1 ta |  |

**Javob `200`:** 

```json
{
  "id": "key_1",
  "prefix": "obk_ABCD",
  "scopes": [
    "logs:read"
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — API key not found. · `409` API_KEY_REVOKED — A revoked key cannot be modified. · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/api-keys/{id}`

**Nima qiladi:** API kalitini darhol bekor qiladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-integrations', 'title': 'Settings · Integrations', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `ApiKeysController_revoke` · original: _Revokes an API key immediately._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "success": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — API key not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-drivers"></a>

## Haydovchilar

### `GET /api/drivers`

**Nima qiladi:** Haydovchilar ro'yxati: CDL, istisnolar, holat.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_list` · original: _Lists drivers with CDL, exceptions, and status (TZ §5.3)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `status` | query | `ACTIVE` \| `INACTIVE` \| `TERMINATED` | yo'q |  |  |
| `q` | query | string | yo'q | ≤ 200 belgi |  |
| `sort` | query | string | yo'q | ≤ 60 belgi |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "drv_1",
      "username": "jsmith",
      "cdlNumber": "D1234567"
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/drivers`

**Nima qiladi:** Haydovchi yaratadi (CDL, home terminal timezone, HOS ruleset, istisno bayroqlari).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_create` · original: _Creates a driver (CDL, home terminal timezone, HOS ruleset, exception flags)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `username` | string | ha | 3–40 belgi |  |
| `firstName` | string | ha | 1–80 belgi |  |
| `lastName` | string | ha | 1–80 belgi |  |
| `email` | string (email) | yo'q |  |  |
| `phone` | string | yo'q | ≤ 30 belgi |  |
| `cdlNumber` | string | ha | 1–40 belgi |  |
| `cdlState` | string | ha | 2–10 belgi |  |
| `homeTerminalName` | string | ha | 1–120 belgi |  |
| `homeTerminalTimezone` | string | yo'q | 1–64 belgi, default `"America/New_York"` |  |
| `hosRuleset` | `US_70_8_PROPERTY` \| `US_60_7_PROPERTY` \| `US_70_8_PASSENGER` \| `US_60_7_PASSENGER` | yo'q |  |  |
| `fleetManagerId` | string (uuid) | yo'q |  |  |
| `allowPersonalConveyance` | boolean | yo'q | default `false` |  |
| `allowYardMove` | boolean | yo'q | default `false` |  |
| `adverseDrivingEnabled` | boolean | yo'q | default `false` |  |
| `shortHaulException` | boolean | yo'q | default `false` |  |
| `splitSleeperEnabled` | boolean | yo'q | default `false` |  |
| `eldExempt` | boolean | yo'q | default `false` |  |
| `eldExemptReason` | string | yo'q | ≤ 200 belgi |  |
| `password` | string | yo'q | 8–72 belgi |  |
| `sendInvitation` | boolean | yo'q | default `true` |  |
| `assignedVehicleId` | string (uuid) | yo'q, null mumkin |  |  |

**Javob `201`:** 

```json
{
  "id": "drv_9",
  "username": "awebb",
  "status": "ACTIVE",
  "homeTerminalTimezone": "America/New_York"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `409` Field-level conflict — one of: USERNAME_TAKEN (details.username: "A driver with this username already exists."); EMAIL_TAKEN (details.ema… · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/drivers/export`

**Nima qiladi:** Barcha haydovchilarni `POST /drivers/import` qabul qiladigan formatda eksport qiladi (parolsiz).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_export` · original: _Exports all drivers as the same shape `POST /drivers/import` accepts (round-trips without loss, minus passwords)._

**Javob `200`:** Every driver in the import payload shape.

```json
{
  "drivers": [
    {
      "username": "jsmith",
      "firstName": "John",
      "lastName": "Smith",
      "cdlNumber": "W8569238",
      "cdlState": "OH",
      "homeTerminalTimezone": "America/New_York",
      "hosRuleset": "US_70_8_PROPERTY"
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/drivers/roster`

**Nima qiladi:** W-06 roster: har haydovchi uchun HOS soatlari, joriy duty status, unit va ochiq violation soni.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_roster` · original: _W-06 roster: per driver the HOS engine clocks, current duty status, assigned unit and open violation count._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `exempt` | query | `true` \| `false` | yo'q |  | Filters on `eldExempt`. |
| `hasOpenViolation` | query | `true` \| `false` | yo'q |  |  |
| `terminal` | query | string | yo'q | ≤ 120 belgi | Exact home terminal name (case-insensitive). |
| `status` | query | `ACTIVE` \| `INACTIVE` \| `TERMINATED` | yo'q |  |  |
| `q` | query | string | yo'q | ≤ 200 belgi |  |
| `sort` | query | string | yo'q | ≤ 60 belgi |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "driver": {
        "id": "drv_1",
        "username": "jsmith",
        "firstName": "John",
        "lastName": "Smith",
        "homeTerminalName": "Columbus, OH",
        "appVersion": "v2.24",
        "email": "john@example.com",
        "eldExempt": false,
        "allowPersonalConveyance": true,
        "allowYardMove": true,
        "shortHaulException": false,
        "splitSleeperEnabled": false
      },
      "dutyStatus": "DRIVING",
      "unit": {
        "id": "veh_1",
        "unitNumber": "101"
      },
      "hos": {
        "driveRemainingSec": 16200,
        "shiftRemainingSec": 20400,
        "cycleRemainingSec": 252000
      },
      "openViolations": 0,
      "emailVerified": null
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/drivers/{id}/hos`

**Nima qiladi:** Bitta haydovchining 4 ta HOS soati, HOS engine hozir hisoblaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_hos` · original: _The four HOS clocks for one driver, computed now by the HOS engine (never from daily totals)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "driveRemainingSec": 16200,
  "shiftRemainingSec": 20400,
  "cycleRemainingSec": 180000,
  "breakInSec": 7440,
  "onDutySince": "2026-09-12T14:26:00.000Z",
  "cycleLimitSec": 252000,
  "shiftLimitSec": 50400,
  "driveLimitSec": 39600,
  "breakLimitSec": 28800,
  "dutyStatus": "DRIVING",
  "statusSince": "2026-09-12T18:00:00.000Z",
  "computedAt": "2026-09-12T20:00:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/drivers/{id}`

**Nima qiladi:** Bitta haydovchi profili.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_get` · original: _Gets one driver profile._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "drv_1",
  "username": "jsmith",
  "firstName": "John",
  "lastName": "Smith",
  "status": "ACTIVE",
  "cdlNumber": "W8569238",
  "cdlState": "OH",
  "homeTerminalTimezone": "America/New_York",
  "assignedVehicleId": "veh_1",
  "allowPersonalConveyance": true,
  "allowYardMove": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/drivers/{id}`

**Nima qiladi:** Haydovchi profili, CDL yoki istisno bayroqlarini yangilaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_update` · original: _Updates a driver profile, CDL, or exception flags._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `firstName` | string | yo'q | 1–80 belgi |  |
| `lastName` | string | yo'q | 1–80 belgi |  |
| `email` | string (email) | yo'q |  |  |
| `phone` | string | yo'q | ≤ 30 belgi |  |
| `cdlNumber` | string | yo'q | 1–40 belgi |  |
| `cdlState` | string | yo'q | 2–10 belgi |  |
| `homeTerminalName` | string | yo'q | 1–120 belgi |  |
| `homeTerminalTimezone` | string | yo'q | 1–64 belgi, default `"America/New_York"` |  |
| `hosRuleset` | `US_70_8_PROPERTY` \| `US_60_7_PROPERTY` \| `US_70_8_PASSENGER` \| `US_60_7_PASSENGER` | yo'q |  |  |
| `fleetManagerId` | string (uuid) | yo'q |  |  |
| `allowPersonalConveyance` | boolean | yo'q | default `false` |  |
| `allowYardMove` | boolean | yo'q | default `false` |  |
| `adverseDrivingEnabled` | boolean | yo'q | default `false` |  |
| `shortHaulException` | boolean | yo'q | default `false` |  |
| `splitSleeperEnabled` | boolean | yo'q | default `false` |  |
| `eldExempt` | boolean | yo'q | default `false` |  |
| `eldExemptReason` | string | yo'q | ≤ 200 belgi |  |
| `sendInvitation` | boolean | yo'q | default `true` |  |
| `status` | `ACTIVE` \| `INACTIVE` \| `TERMINATED` | yo'q |  |  |

**Javob `200`:** 

```json
{
  "id": "drv_1",
  "username": "jsmith",
  "status": "ACTIVE",
  "allowPersonalConveyance": false
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `409` Field-level conflict — one of: EMAIL_TAKEN (details.email: "A driver with this email address already exists."); PHONE_TAKEN (details.phon… · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/drivers/{id}`

**Nima qiladi:** Haydovchini soft-delete qiladi (TERMINATED, unit ajratiladi). Hech qachon to'liq o'chirmaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_remove` · original: _Soft-deletes a driver (status -> TERMINATED, unassigns their unit). Never hard-deletes — see bugs.md B-009._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** Soft-deleted — status is TERMINATED, the unit is unassigned.

```json
{
  "id": "drv_1",
  "status": "TERMINATED",
  "assignedVehicleId": null
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/drivers/import`

**Nima qiladi:** Haydovchilarni ommaviy import qiladi; `username` bo'yicha upsert.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_import` · original: _Bulk-imports drivers; upserts by `username`._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `drivers` | object[] | ha | 1–1000 ta |  |
| `drivers[].username` | string | ha | 3–40 belgi |  |
| `drivers[].firstName` | string | ha | 1–80 belgi |  |
| `drivers[].lastName` | string | ha | 1–80 belgi |  |
| `drivers[].email` | string (email) | yo'q |  |  |
| `drivers[].phone` | string | yo'q | ≤ 30 belgi |  |
| `drivers[].cdlNumber` | string | ha | 1–40 belgi |  |
| `drivers[].cdlState` | string | ha | 2–10 belgi |  |
| `drivers[].homeTerminalName` | string | ha | 1–120 belgi |  |
| `drivers[].homeTerminalTimezone` | string | yo'q | 1–64 belgi, default `"America/New_York"` |  |
| `drivers[].hosRuleset` | `US_70_8_PROPERTY` \| `US_60_7_PROPERTY` \| `US_70_8_PASSENGER` \| `US_60_7_PASSENGER` | yo'q |  |  |
| `drivers[].fleetManagerId` | string (uuid) | yo'q |  |  |
| `drivers[].allowPersonalConveyance` | boolean | yo'q | default `false` |  |
| `drivers[].allowYardMove` | boolean | yo'q | default `false` |  |
| `drivers[].adverseDrivingEnabled` | boolean | yo'q | default `false` |  |
| `drivers[].shortHaulException` | boolean | yo'q | default `false` |  |
| `drivers[].splitSleeperEnabled` | boolean | yo'q | default `false` |  |
| `drivers[].eldExempt` | boolean | yo'q | default `false` |  |
| `drivers[].eldExemptReason` | string | yo'q | ≤ 200 belgi |  |
| `drivers[].password` | string | yo'q | 8–72 belgi |  |
| `drivers[].sendInvitation` | boolean | yo'q | default `true` |  |
| `drivers[].assignedVehicleId` | string (uuid) | yo'q, null mumkin |  |  |
| `options` | object | yo'q |  |  |
| `options.duplicateStrategy` | `SKIP` \| `UPDATE` \| `CREATE` | yo'q | default `"UPDATE"` |  |
| `options.defaultHomeTerminalName` | string | yo'q | 1–120 belgi |  |
| `options.sendInvitations` | boolean | yo'q | default `false` |  |
| `options.applyDefaultExemptions` | boolean | yo'q | default `false` |  |

**Javob `200`:** 

```json
{
  "imported": 3,
  "updated": 1,
  "failed": []
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` IMPORT_FAILED — One or more rows could not be imported.

---

### `POST /api/drivers/{id}/reset-password`

**Nima qiladi:** Dispetcher tomonidan haydovchi ilova parolini tiklash (email yoki og'zaki aytiladigan bir martalik kod). Audit qilinadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_resetPassword` · original: _B-81 — carrier-side reset of a driver-app password (email or a one-time code for the dispatcher to read out). Always audited._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "emailedTo": "jsmith@example.com"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/drivers/{id}/send-verification`

**Nima qiladi:** `Driver.email` ni tasdiqlash tokenini emailga yuboradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_sendVerification` · original: _B-29/B-30 — emails a verification token for `Driver.email`._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "emailedTo": "jsmith@example.com"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/drivers/{id}/verify-email`

**Nima qiladi:** `send-verification` tokenini tasdiqlaydi; `emailVerifiedAt` o'rnatiladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_verifyEmail` · original: _B-31 — confirms the token from `send-verification`; sets `emailVerifiedAt`._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `token` | string | ha | ≥ 1 belgi |  |

**Javob `200`:** 

```json
{
  "id": "drv_1",
  "email": "jsmith@example.com",
  "emailVerifiedAt": "2026-09-24T00:00:00.000Z"
}
```

**Xatolar:** `401` TOKEN_INVALID — Verification token is no longer valid. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/drivers/{id}/documents`

**Nima qiladi:** Haydovchi hujjatlari ro'yxati (CDL skani, medical card va h.k.).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_listDocuments` · original: _B-94 — lists a driver's qualification documents (CDL scan, medical card, ...)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
[
  {
    "id": "doc_1",
    "type": "CDL",
    "fileName": "cdl-front.jpg",
    "expiresAt": "2028-01-01T00:00:00.000Z",
    "uploadedAt": "2026-09-24T00:00:00.000Z",
    "url": "https://minio/..."
  }
]
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/drivers/{id}/documents`

**Nima qiladi:** Hujjat metadata'sini yozadi va fayl yuklash uchun presigned PUT URL qaytaradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_createDocument` · original: _B-94 — records document metadata and returns a presigned PUT for the file upload (TZ §17)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `type` | `CDL` \| `MEDICAL_CARD` \| `MVR` \| `OTHER` | ha |  |  |
| `fileName` | string | ha | 1–200 belgi |  |
| `contentType` | `application/pdf` \| `image/jpeg` \| `image/png` \| `image/heic` \| `image/webp` | ha |  |  |
| `sizeBytes` | integer | ha | 1–10485760 |  |
| `expiresAt` | string (date-time) | yo'q |  |  |

**Javob `201`:** 

```json
{
  "id": "doc_1",
  "type": "CDL",
  "fileName": "cdl-front.jpg",
  "expiresAt": null,
  "uploadedAt": "2026-09-24T00:00:00.000Z",
  "url": "https://minio/...",
  "uploadUrl": "https://minio/... (PUT)"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/drivers/{id}/documents/{docId}`

**Nima qiladi:** Haydovchi hujjatini o'chiradi (storage obyekti va qator).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`, `{'id': 'web/driver-add', 'title': 'Add driver', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.12'}`
- **operationId:** `DriversController_removeDocument` · original: _B-94 — deletes a driver document (storage object and row)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |
| `docId` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "deleted": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_DOCUMENT_NOT_FOUND — Driver document not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-transfers"></a>

## eRODS transferlar

### `POST /api/transfers`

**Nima qiladi:** eRODS transfer so'raydi: §395 Appendix A output faylini yaratadi, tekshiradi, saqlaydi va yuborishni navbatga qo'yadi. TEST rejimda FMCSA'ga yuborilmaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/send-logs-to-safety-official', 'title': 'Send logs to a safety official', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.16'}`, `{'id': 'web/reports-fmcsa-audit-pack', 'title': 'Reports · FMCSA / DOT audit pack', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.21'}`
- **operationId:** `TransfersController_create` · original: _Requests an eRODS data transfer: generates the §395 Appendix A output file, validates it, stores it and queues the send step. In TEST mode the file is NOT sent to FMCSA._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `driverId` | string (uuid) | ha |  |  |
| `method` | `WEB_SERVICES` \| `EMAIL` | ha |  |  |
| `rangeStart` | string (date-time) | ha |  |  |
| `rangeEnd` | string (date-time) | ha |  |  |
| `outputFileComment` | string | yo'q | ≤ 60 belgi, default `""` |  |
| `recipient` | string | yo'q | ≤ 254 belgi |  |

**Javob `200`:** 

```json
{
  "transfer": {
    "id": "trf_1",
    "fileName": "SMITH38018.csv",
    "status": "QUEUED",
    "erodsMode": "TEST",
    "fileSizeBytes": 2048
  },
  "warnings": [
    {
      "code": "ERODS_TEST_MODE",
      "level": "warning",
      "message": "eRODS is in TEST mode …"
    }
  ],
  "counts": {
    "header": 9,
    "events": 42
  }
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — dataTransfer = FULL is required — only ADMIN and FLEET_MANAGER may send the FMCSA package (§6.4, B-95). · `404` DRIVER_NOT_FOUND — Driver not found. · `422` TRANSFER_VALIDATION_FAILED — The generated output file failed Appendix A validation — nothing was sent.

---

### `GET /api/transfers`

**Nima qiladi:** Transferlar tarixi. `TEST_ONLY` — yaratilgan, lekin yuborilmagan fayllar.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/send-logs-to-safety-official', 'title': 'Send logs to a safety official', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.16'}`, `{'id': 'web/reports-fmcsa-audit-pack', 'title': 'Reports · FMCSA / DOT audit pack', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.21'}`
- **operationId:** `TransfersController_list` · original: _Transfer history (§10). `TEST_ONLY` rows are files that were generated but never sent._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `driverId` | query | string (uuid) | yo'q |  |  |
| `status` | query | `QUEUED` \| `TEST_ONLY` \| `SENT` \| `ACCEPTED` \| `REJECTED` \| `FAILED` \| `ALL` | yo'q | default `"ALL"` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "trf_1",
      "sentAt": "2026-09-02T13:14:00.000Z",
      "method": "WEB_SERVICES",
      "comment": "TERMINAL AUDIT 2025-09-02",
      "periodFrom": "2026-07-01",
      "periodTo": "2026-08-31",
      "status": "ACCEPTED",
      "sentById": "usr_1",
      "fileName": "SMITH38018.csv"
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/transfers/{id}`

**Nima qiladi:** Bitta transfer yozuvi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/send-logs-to-safety-official', 'title': 'Send logs to a safety official', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.16'}`, `{'id': 'web/reports-fmcsa-audit-pack', 'title': 'Reports · FMCSA / DOT audit pack', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.21'}`
- **operationId:** `TransfersController_get` · original: _One transfer record._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "trf_1",
  "method": "WEB_SERVICES",
  "status": "ACCEPTED",
  "erodsMode": "TEST",
  "comment": "ROADSIDE INSPECTION 2026-09-10",
  "fileName": "SMITH38018.csv",
  "fileSizeBytes": 2048,
  "counts": {
    "header": 9,
    "events": 42
  },
  "sentAt": "2026-09-11T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Transfer not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/transfers/{id}/download`

**Nima qiladi:** Yaratilgan Appendix A faylini rasmiy fayl nomi bilan yuklab beradi (TEST rejimda ham ishlaydi).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/send-logs-to-safety-official', 'title': 'Send logs to a safety official', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.16'}`, `{'id': 'web/reports-fmcsa-audit-pack', 'title': 'Reports · FMCSA / DOT audit pack', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.21'}`
- **operationId:** `TransfersController_download` · original: _Downloads the generated Appendix A output file under its 4.8.2.2 file name. Works in TEST mode — that is how the file reaches an inspector until FMCSA registration completes._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** The Appendix A CSV itself (text/csv), named per §4.8.2.2. Not wrapped in the success envelope.

```json
"Header,ONEB01,Universal Logistics Inc.,1234567\nUser,Smith,John,W8569238,OH\nCMV,101,1FUJGLDR8LLLL1234,993107\n"
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — reportsTransfer is NONE for DISPATCHER and VIEWER — even the download is a 403 (§6.4). · `404` NOT_FOUND — Transfer not found. · `422` CHECKSUM_MISMATCH — The stored output file does not match its checksum — it is not trustworthy.

---

<a id="bolim-vehicles"></a>

## Unitlar (vehicles)

### `GET /api/vehicles`

**Nima qiladi:** Unitlar ro'yxati — unit raqami, VIN, odometr, holat.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`, `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`
- **operationId:** `VehiclesController_list` · original: _Lists vehicles — unit number, VIN, odometer, status (TZ §5.3 "Vehicles" screen)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `groupId` | query | string (uuid) yoki `none` | yo'q |  | A vehicle-group id, or `none` for ungrouped units. |
| `status` | query | `ACTIVE` \| `INACTIVE` \| `OUT_OF_SERVICE` | yo'q |  |  |
| `q` | query | string | yo'q | ≤ 200 belgi |  |
| `sort` | query | string | yo'q | ≤ 60 belgi |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "veh_1",
      "unitNumber": "#101",
      "vin": "1FUJA6CV88LW12345",
      "status": "ACTIVE"
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/vehicles`

**Nima qiladi:** Unit qo'shadi (VIN, qo'shilgan paytdagi dashboard odometri).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`, `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`
- **operationId:** `VehiclesController_create` · original: _Adds a unit (VIN, dash odometer at add-time per TZ §4.3 step 1)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `unitNumber` | string | ha | 1–40 belgi |  |
| `vin` | string | ha |  |  |
| `make` | string | yo'q | ≤ 60 belgi |  |
| `model` | string | yo'q | ≤ 60 belgi |  |
| `year` | integer | yo'q | 1900–2100 |  |
| `licensePlate` | string | yo'q, null mumkin | ≤ 20 belgi |  |
| `plateState` | string | yo'q, null mumkin | ≤ 10 belgi |  |
| `fuelType` | `DIESEL` \| `GASOLINE` \| `CNG` \| `LNG` \| `ELECTRIC` | yo'q |  |  |
| `sleeperBerth` | boolean | yo'q | default `false` |  |
| `odometerMi` | integer | yo'q | ≥ 0, default `0` |  |
| `busType` | `J1939` \| `J1708` \| `OBD_II` | yo'q |  |  |
| `notes` | string | yo'q | ≤ 500 belgi |  |
| `groupId` | string (uuid) | yo'q, null mumkin |  |  |
| `deviceId` | string | yo'q, null mumkin | ≤ 60 belgi |  |
| `eldSerial` | string | yo'q, null mumkin | ≤ 60 belgi |  |

**Javob `201`:** 

```json
{
  "id": "veh_9",
  "unitNumber": "126",
  "vin": "1FUJHHDR5NLNN4410",
  "status": "ACTIVE",
  "odometerMiles": 221449
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEVICE_NOT_FOUND — No ELD device with this serial is registered. · `409` Field-level conflict — one of: UNIT_NUMBER_TAKEN (details.unitNumber: "A unit with this number already exists."); VIN_TAKEN (details.vin:… · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/vehicles/export`

**Nima qiladi:** Barcha unitlarni `POST /vehicles/import` formatida eksport qiladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`, `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`
- **operationId:** `VehiclesController_export` · original: _Exports all vehicles as the same shape `POST /vehicles/import` accepts (round-trips without loss)._

**Javob `200`:** Every unit in the import payload shape.

```json
{
  "vehicles": [
    {
      "unitNumber": "101",
      "vin": "1FUJGLDR8LLLL1234",
      "make": "Freightliner",
      "model": "Cascadia",
      "year": 2021,
      "fuelType": "DIESEL",
      "odometerMiles": 993107
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/vehicles/{id}`

**Nima qiladi:** Bitta unit (Unit detail ekrani).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`, `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`
- **operationId:** `VehiclesController_get` · original: _Gets one vehicle (TZ §5.3 "Unit detail" screen)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "veh_1",
  "unitNumber": "101",
  "vin": "1FUJGLDR8LLLL1234",
  "make": "Freightliner",
  "model": "Cascadia",
  "year": 2021,
  "status": "ACTIVE",
  "odometerMiles": 993107,
  "odometerOffsetMiles": 12,
  "assignedDriverId": "drv_1"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/vehicles/{id}`

**Nima qiladi:** Unitni tahrirlaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`, `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`
- **operationId:** `VehiclesController_update` · original: _Edits a unit._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `unitNumber` | string | yo'q | 1–40 belgi |  |
| `vin` | string | yo'q |  |  |
| `make` | string | yo'q | ≤ 60 belgi |  |
| `model` | string | yo'q | ≤ 60 belgi |  |
| `year` | integer | yo'q | 1900–2100 |  |
| `licensePlate` | string | yo'q, null mumkin | ≤ 20 belgi |  |
| `plateState` | string | yo'q, null mumkin | ≤ 10 belgi |  |
| `fuelType` | `DIESEL` \| `GASOLINE` \| `CNG` \| `LNG` \| `ELECTRIC` | yo'q |  |  |
| `sleeperBerth` | boolean | yo'q | default `false` |  |
| `odometerMi` | integer | yo'q | ≥ 0, default `0` |  |
| `busType` | `J1939` \| `J1708` \| `OBD_II` | yo'q |  |  |
| `notes` | string | yo'q | ≤ 500 belgi |  |
| `groupId` | string (uuid) | yo'q, null mumkin |  |  |
| `deviceId` | string | yo'q, null mumkin | ≤ 60 belgi |  |
| `eldSerial` | string | yo'q, null mumkin | ≤ 60 belgi |  |
| `status` | `ACTIVE` \| `INACTIVE` \| `OUT_OF_SERVICE` | yo'q |  |  |

**Javob `200`:** 

```json
{
  "id": "veh_1",
  "unitNumber": "101",
  "status": "ACTIVE",
  "licensePlate": "PQR-4821",
  "licenseState": "OH"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found; or DEVICE_NOT_FOUND (details.eldSerial) — the `deviceId` serial names no registered device. · `409` Field-level conflict — one of: UNIT_NUMBER_TAKEN (details.unitNumber: "A unit with this number already exists."); VIN_TAKEN (details.vin:… · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/vehicles/{id}`

**Nima qiladi:** Unitni soft-delete qiladi (INACTIVE, haydovchi ajratiladi).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`, `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`
- **operationId:** `VehiclesController_remove` · original: _Soft-deletes a unit (status -> INACTIVE, unassigns its driver). Never hard-deletes — see bugs.md B-009._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** Soft-deleted — status INACTIVE, driver unassigned.

```json
{
  "id": "veh_1",
  "status": "INACTIVE",
  "assignedDriverId": null
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/vehicles/{id}/activities`

**Nima qiladi:** "Unit activity" lentasi: audit yozuvlari + shu unit DVIR'lari.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`, `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`
- **operationId:** `VehiclesController_activities` · original: _B-5 — "Unit activity" feed (audit trail + DVIR submissions for this unit)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "dvir_1",
      "occurredAt": "2026-09-24T13:00:00.000Z",
      "activity": "DVIR_PRE_TRIP",
      "driverName": "John Smith",
      "source": "DVIR",
      "details": "SATISFACTORY"
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/vehicles/{id}/histories` ♻️ O'ZGARGAN

**Nima qiladi:** W-05 Unit histories: server tomonda kunni DRIVE/STOP/IDLE segmentlarga ajratadi. 🆕 lat/lon endi `null` bo'lishi mumkin (GPS fix yo'q kun).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`, `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`
- **operationId:** `VehiclesController_histories` · original: _B-4 — W-05 Unit histories: server-side DRIVE/STOP/IDLE day segmentation (never raw telemetry to the browser)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |
| `date` | query | string | ha | pattern `^\d{4}-\d{2}-\d{2}$` | YYYY-MM-DD, in the assigned driver / carrier home-terminal timezone. |

**Javob `200`:** 

```json
{
  "date": "2026-09-24",
  "distanceMi": 312.4,
  "driveSegments": 3,
  "driveTimeSec": 21600,
  "avgSpeedMph": 52,
  "stopCount": 2,
  "stopTimeSec": 5400,
  "idleTimeSec": 900,
  "idleFuelWastedGal": 0.6,
  "firstMovementAt": "2026-09-24T11:00:00.000Z",
  "lastMovementAt": "2026-09-24T23:00:00.000Z",
  "engineOnSec": 22500,
  "engineOffSec": 5400,
  "longestDrive": {
    "label": "40.7128, -74.0060",
    "durationSec": 10800
  },
  "longestStop": {
    "label": "39.9612, -82.9988",
    "durationSec": 3600
  },
  "maxSpeedMph": 68,
  "maxSpeedAt": "2026-09-24T15:00:00.000Z",
  "segments": []
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `422` VALIDATION_FAILED — Invalid date.

---

### `GET /api/vehicles/{id}/telemetry` ♻️ O'ZGARGAN

**Nima qiladi:** Unitning oxirgi telemetriya nuqtalari (Virtual Dashboard), eng yangisi birinchi. 🆕 lat/lon `null` bo'lishi mumkin; yangi VDB ustunlari (intakePressureKpa, barometerKpa, fuelTempC, intercoolerTempC, turboOilTempC, retarderPct, brakePedal, odometerComputed, engineHoursComputed, gpsLocked, gpsSatellites, gpsDop, gpsAgeSec).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`, `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`
- **operationId:** `VehiclesController_telemetry` · original: _Telemetry read path (Virtual Dashboard, TZ §5.6) — most recent points for this unit, newest first._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |
| `limit` | query | integer | yo'q | 1–2000, default `500` |  |
| `to` | query | string (date-time) | yo'q |  |  |
| `from` | query | string (date-time) | yo'q |  |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "time": "2026-09-24T15:00:00.000Z",
      "vehicleId": "veh_1",
      "speedMph": 62,
      "latitude": 40.7128,
      "longitude": -74.006
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/vehicles/import`

**Nima qiladi:** Unitlarni ommaviy import qiladi; `unitNumber`/`vin` bo'yicha upsert.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`, `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`
- **operationId:** `VehiclesController_import` · original: _Bulk-imports vehicles; upserts by `unitNumber`/`vin`._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `vehicles` | object[] | ha | 1–1000 ta |  |
| `vehicles[].unitNumber` | string | ha | 1–40 belgi |  |
| `vehicles[].vin` | string | ha |  |  |
| `vehicles[].make` | string | yo'q | ≤ 60 belgi |  |
| `vehicles[].model` | string | yo'q | ≤ 60 belgi |  |
| `vehicles[].year` | integer | yo'q | 1900–2100 |  |
| `vehicles[].licensePlate` | string | yo'q, null mumkin | ≤ 20 belgi |  |
| `vehicles[].plateState` | string | yo'q, null mumkin | ≤ 10 belgi |  |
| `vehicles[].fuelType` | `DIESEL` \| `GASOLINE` \| `CNG` \| `LNG` \| `ELECTRIC` | yo'q |  |  |
| `vehicles[].sleeperBerth` | boolean | yo'q | default `false` |  |
| `vehicles[].odometerMi` | integer | yo'q | ≥ 0, default `0` |  |
| `vehicles[].busType` | `J1939` \| `J1708` \| `OBD_II` | yo'q |  |  |
| `vehicles[].notes` | string | yo'q | ≤ 500 belgi |  |
| `vehicles[].groupId` | string (uuid) | yo'q, null mumkin |  |  |
| `vehicles[].deviceSerial` | string | yo'q | ≤ 60 belgi |  |
| `options` | object | yo'q |  |  |
| `options.duplicateStrategy` | `UPDATE_BY_VIN` \| `SKIP` \| `CREATE` | yo'q | default `"UPDATE_BY_VIN"` |  |
| `options.defaultTerminal` | string | yo'q | ≤ 120 belgi |  |
| `options.pairDevices` | boolean | yo'q | default `false` |  |
| `options.emailSummary` | boolean | yo'q | default `false` |  |

**Javob `200`:** 

```json
{
  "imported": 2,
  "updated": 0,
  "skipped": 0,
  "failed": []
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` IMPORT_FAILED — One or more rows could not be imported.

---

### `PATCH /api/vehicles/bulk-status`

**Nima qiladi:** Ko'p unitning `status`ini bitta so'rovda o'zgartiradi; har qatorga OOS qoidasi alohida qo'llanadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`, `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`
- **operationId:** `VehiclesController_bulkUpdateStatus` · original: _B-71 — updates `status` on many units in one call; each row goes through the OOS hard rule independently._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `ids` | string (uuid)[] | ha | 1–500 ta |  |
| `status` | `ACTIVE` \| `INACTIVE` \| `OUT_OF_SERVICE` | ha |  |  |

**Javob `200`:** 

```json
{
  "updated": [
    "veh_1",
    "veh_2"
  ],
  "failed": []
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/vehicles/{id}/calibrate-odometer`

**Nima qiladi:** PT30 ko'rsatkichiga nisbatan odometr offsetini qayta kalibrlaydi. Audit qilinadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`, `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`
- **operationId:** `VehiclesController_calibrateOdometer` · original: _TZ §4.3 step 4 — recalibrates the odometer offset against the PT30 reading. Always audited._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `odometerMi` | integer | ha | ≥ 0 |  |

**Javob `201`:** New offset = dash reading − device reading (TZ §4.3 step 4); the change is audited.

```json
{
  "id": "veh_1",
  "odometerOffsetMiles": 12,
  "dashOdometerMiles": 993119,
  "deviceOdometerMiles": 993107
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `422` ODOMETER_ANOMALY — Reading differs from the recorded odometer by more than the allowed tolerance.

---

### `POST /api/vehicles/{id}/assign-driver`

**Nima qiladi:** Unitga haydovchi biriktiradi. Unit OUT_OF_SERVICE bo'lsa bloklanadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`, `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`
- **operationId:** `VehiclesController_assignDriver` · original: _Assigns a driver to this unit. Blocked while the unit is OUT_OF_SERVICE. Requires vehicles:FULL or trips:FULL (B-13)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `driverId` | string (uuid) | ha |  |  |
| `effectiveAt` | string (date-time) | yo'q |  |  |
| `notify` | boolean | yo'q | default `true` |  |

**Javob `201`:** 

```json
{
  "id": "veh_1",
  "unitNumber": "101",
  "assignedDriverId": "drv_1"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `409` VEHICLE_OUT_OF_SERVICE — Unit is OUT_OF_SERVICE — assign a driver only after the critical defect is closed. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/vehicles/{id}/unassign-driver`

**Nima qiladi:** Unitdagi joriy haydovchini ajratadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`, `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`
- **operationId:** `VehiclesController_unassignDriver` · original: _Clears the driver currently assigned to this unit, if any._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `201`:** 

```json
{
  "id": "veh_1",
  "unitNumber": "101",
  "assignedDriverId": null
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-trailers"></a>

## Treylerlar

### `GET /api/trailers`

**Nima qiladi:** Treylerlar ro'yxati (o'chirilmaganlar), sahifalangan.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`
- **operationId:** `TrailersController_list` · original: _Lists live (not deleted) trailers, paginated like `GET /vehicles`._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `status` | query | `ACTIVE` \| `INACTIVE` \| `OUT_OF_SERVICE` | yo'q |  |  |
| `q` | query | string | yo'q | ≤ 200 belgi | Case-insensitive substring match on trailer number or VIN. |
| `sort` | query | string | yo'q | ≤ 60 belgi | `number\|vin\|status` + `:asc\|:desc` (default `number:asc`). |
| `limit` | query | integer | yo'q | 1–200, default `25` | Page size, 1–200 (default 25). |
| `page` | query | integer | yo'q | ≥ 1, default `1` | 1-based page number (default 1). |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "trl_1",
      "number": "T-4471",
      "vin": "1JJV532W7YL123456",
      "status": "ACTIVE",
      "deletedAt": null
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/trailers`

**Nima qiladi:** Treyler qo'shadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`
- **operationId:** `TrailersController_create` · original: _Adds a trailer._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `number` | string | ha | 1–40 belgi |  |
| `vin` | string | yo'q | ≤ 17 belgi |  |

**Javob `201`:** 

```json
{
  "id": "trl_9",
  "number": "T-4480",
  "licensePlate": "TRL-1180",
  "licenseState": "OH"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `409` CONFLICT — A live trailer with this number already exists (a deleted trailer's number is reusable). · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/trailers/export`

**Nima qiladi:** Treylerlarni `POST /trailers/import` formatida eksport qiladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`
- **operationId:** `TrailersController_export` · original: _Exports all live (not deleted) trailers as the same shape `POST /trailers/import` accepts._

**Javob `200`:** Every trailer in the import payload shape.

```json
{
  "trailers": [
    {
      "number": "T-4471",
      "vin": "1JJV532W7YL123456",
      "licensePlate": "TRL-9921",
      "licenseState": "OH"
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/trailers/{id}`

**Nima qiladi:** Bitta treyler (o'chirilgan bo'lsa 404).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`
- **operationId:** `TrailersController_get` · original: _Gets one live trailer (a soft-deleted trailer is a 404)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "trl_1",
  "number": "T-4471",
  "vin": "1JJV532W7YL123456",
  "licensePlate": "TRL-9921",
  "licenseState": "OH"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Trailer not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/trailers/{id}`

**Nima qiladi:** Treylerni tahrirlaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`
- **operationId:** `TrailersController_update` · original: _Edits a live trailer (a soft-deleted trailer is a 404)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `number` | string | yo'q | 1–40 belgi |  |
| `vin` | string | yo'q | ≤ 17 belgi |  |
| `status` | `ACTIVE` \| `INACTIVE` \| `OUT_OF_SERVICE` | yo'q |  |  |

**Javob `200`:** 

```json
{
  "id": "trl_1",
  "number": "T-4471",
  "vin": "1JJV532W7YL123456",
  "status": "ACTIVE",
  "deletedAt": null
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Trailer not found. · `409` CONFLICT — A live trailer with this number already exists. · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/trailers/{id}`

**Nima qiladi:** Treylerni soft-delete qiladi: ro'yxatdan yashiriladi, raqami bo'shaydi, eski DVIR/trip'lar uni ko'rsataveradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`
- **operationId:** `TrailersController_remove` · original: _Soft-deletes a trailer: hidden from list/lookup/export and no longer assignable, its number is freed for reuse, historical DVIRs/trips keep resolving it. Deleting an already-deleted trailer is a 404._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "success": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Trailer not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/trailers/import`

**Nima qiladi:** Treylerlarni ommaviy import qiladi; `number` bo'yicha upsert.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`
- **operationId:** `TrailersController_import` · original: _Bulk-imports trailers; upserts by `number` among live trailers (a number held only by a deleted trailer creates a new one)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `trailers` | object[] | ha | 1–1000 ta |  |
| `trailers[].number` | string | ha | 1–40 belgi |  |
| `trailers[].vin` | string | yo'q | ≤ 17 belgi |  |

**Javob `201`:** 

```json
{
  "imported": 2,
  "updated": 0,
  "failed": []
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` IMPORT_FAILED — One or more rows could not be imported.

---

<a id="bolim-vehicle-groups"></a>

## Unit guruhlari

### `GET /api/vehicle-groups`

**Nima qiladi:** Unit guruhlari ro'yxati, unit sonlari bilan.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`
- **operationId:** `VehicleGroupsController_list` · original: _Lists vehicle groups (name order) with their unit counts._

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "vg_1",
      "name": "Midwest linehaul",
      "description": "OH/IN/KY lanes",
      "color": "#2F6FED",
      "vehicleCount": 14,
      "createdAt": "2026-09-25T09:00:00.000Z",
      "updatedAt": "2026-09-25T09:00:00.000Z"
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/vehicle-groups`

**Nima qiladi:** Unit guruhi yaratadi; ixtiyoriy `vehicleIds` shu unitlarni guruhga o'tkazadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`
- **operationId:** `VehicleGroupsController_create` · original: _Creates a vehicle group; optional `vehicleIds` move those units into it._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `name` | string | ha | 1–80 belgi |  |
| `description` | string | yo'q, null mumkin | ≤ 300 belgi |  |
| `color` | string | yo'q, null mumkin | pattern `^#[0-9a-fA-F]{6}$` |  |
| `vehicleIds` | string (uuid)[] | yo'q | ≤ 1000 ta |  |

**Javob `201`:** 

```json
{
  "id": "vg_1",
  "name": "Midwest linehaul",
  "description": "OH/IN/KY lanes",
  "color": "#2F6FED",
  "vehicleCount": 14,
  "createdAt": "2026-09-25T09:00:00.000Z",
  "updatedAt": "2026-09-25T09:00:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `409` CONFLICT — A vehicle group with this name already exists. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/vehicle-groups/{id}`

**Nima qiladi:** Bitta guruh, unitlari bilan.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`
- **operationId:** `VehicleGroupsController_get` · original: _Gets one vehicle group with its units._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "vg_1",
  "name": "Midwest linehaul",
  "description": "OH/IN/KY lanes",
  "color": "#2F6FED",
  "vehicleCount": 14,
  "createdAt": "2026-09-25T09:00:00.000Z",
  "updatedAt": "2026-09-25T09:00:00.000Z",
  "vehicles": [
    {
      "id": "veh_1",
      "unitNumber": "101",
      "vin": "1FUJGLDR8LLLL1234",
      "make": "Freightliner",
      "model": "Cascadia",
      "status": "ACTIVE"
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_GROUP_NOT_FOUND — Vehicle group not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/vehicle-groups/{id}`

**Nima qiladi:** Guruh nomi/rangini o'zgartiradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`
- **operationId:** `VehicleGroupsController_update` · original: _Renames / recolours a vehicle group._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `name` | string | yo'q | 1–80 belgi |  |
| `description` | string | yo'q, null mumkin | ≤ 300 belgi |  |
| `color` | string | yo'q, null mumkin | pattern `^#[0-9a-fA-F]{6}$` |  |

**Javob `200`:** 

```json
{
  "id": "vg_1",
  "name": "Midwest linehaul",
  "description": "OH/IN/KY lanes",
  "color": "#2F6FED",
  "vehicleCount": 14,
  "createdAt": "2026-09-25T09:00:00.000Z",
  "updatedAt": "2026-09-25T09:00:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_GROUP_NOT_FOUND — Vehicle group not found. · `409` CONFLICT — A vehicle group with this name already exists. · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/vehicle-groups/{id}`

**Nima qiladi:** Guruhni o'chiradi; unitlar guruhsiz qoladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`
- **operationId:** `VehicleGroupsController_remove` · original: _Deletes a vehicle group; its units stay, ungrouped._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "success": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_GROUP_NOT_FOUND — Vehicle group not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PUT /api/vehicle-groups/{id}/vehicles`

**Nima qiladi:** Guruh a'zolarini aynan `vehicleIds` bilan almashtiradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicles', 'title': 'Vehicles', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.8'}`
- **operationId:** `VehicleGroupsController_setMembers` · original: _Replaces the group membership with exactly `vehicleIds` (units not listed leave the group; listed units move in from any other group)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `vehicleIds` | string (uuid)[] | ha | ≤ 1000 ta |  |

**Javob `200`:** 

```json
{
  "id": "vg_1",
  "name": "Midwest linehaul",
  "description": "OH/IN/KY lanes",
  "color": "#2F6FED",
  "vehicleCount": 14,
  "createdAt": "2026-09-25T09:00:00.000Z",
  "updatedAt": "2026-09-25T09:00:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-alert-rules"></a>

## Alert qoidalari

### `GET /api/alert-rules`

**Nima qiladi:** Alert qoidalari ro'yxati (kanallar, throttle, quiet hours, qabul qiluvchilar).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-alert-rules', 'title': 'Settings · Alert rules', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `AlertRulesController_list` · original: _Lists alert rules (channels, throttle, quiet hours, recipients)._

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "alr_1",
      "key": "hos_violation",
      "name": "HOS violation",
      "severity": "CRITICAL",
      "channels": [
        "IN_APP",
        "EMAIL"
      ],
      "enabled": true
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/alert-rules`

**Nima qiladi:** Custom alert qoidasi yaratadi. `channels: ["SMS"]` rad etiladi (v2 da).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-alert-rules', 'title': 'Settings · Alert rules', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `AlertRulesController_create` · original: _Creates a custom alert rule. `channels: ["SMS"]` is rejected — SMS ships in v2._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `key` | string | ha | 1–100 belgi |  |
| `name` | string | ha | 1–200 belgi |  |
| `severity` | `CRITICAL` \| `WARNING` \| `INFO` | ha |  |  |
| `conditions` | object[] | ha | ≥ 1 ta |  |
| `conditions[].event` | string | ha | 1–100 belgi |  |
| `conditions[].params` | object | yo'q |  |  |
| `channels` | `IN_APP` \| `EMAIL` \| `SMS` \| `WEBHOOK`[] | ha | ≥ 1 ta |  |
| `recipients` | object | ha |  |  |
| `recipients.roles` | string[] | yo'q |  |  |
| `recipients.userIds` | string (uuid)[] | yo'q |  |  |
| `recipients.driverIds` | string (uuid)[] | yo'q |  |  |
| `recipients.subjectDriver` | boolean | yo'q |  |  |
| `throttle` | object | yo'q |  |  |
| `throttle.perDriverPerDay` | integer | yo'q | ≥ >True |  |
| `throttle.cooldownMin` | integer | yo'q | ≥ >True |  |
| `quietHours` | object | yo'q |  |  |
| `quietHours.from` | string | ha | pattern `^([01]\d|2[0-3]):[0-5]\d$` |  |
| `quietHours.to` | string | ha | pattern `^([01]\d|2[0-3]):[0-5]\d$` |  |
| `quietHours.timezone` | string | ha | 1–60 belgi |  |
| `enabled` | boolean | yo'q | default `true` |  |

**Javob `201`:** 

```json
{
  "id": "alr_2",
  "key": "custom_geofence_exit",
  "channels": [
    "IN_APP"
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `409` CONFLICT — An alert rule with this key already exists. · `422` CHANNEL_NOT_AVAILABLE — SMS is not available yet.

---

### `GET /api/alert-rules/{id}`

**Nima qiladi:** Bitta alert qoidasi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-alert-rules', 'title': 'Settings · Alert rules', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `AlertRulesController_get` · original: _One alert rule._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "alr_1",
  "key": "hos_violation",
  "channels": [
    "IN_APP",
    "EMAIL"
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Alert rule not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/alert-rules/{id}`

**Nima qiladi:** Alert qoidasini yangilaydi (kanallar, throttle, quiet hours, qabul qiluvchilar, yoqilgan/o'chiq).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-alert-rules', 'title': 'Settings · Alert rules', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `AlertRulesController_update` · original: _Updates an alert rule (channels, throttle, quiet hours, recipients, enabled)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `name` | string | yo'q | 1–200 belgi |  |
| `severity` | `CRITICAL` \| `WARNING` \| `INFO` | yo'q |  |  |
| `conditions` | object[] | yo'q | ≥ 1 ta |  |
| `conditions[].event` | string | ha | 1–100 belgi |  |
| `conditions[].params` | object | yo'q |  |  |
| `channels` | `IN_APP` \| `EMAIL` \| `SMS` \| `WEBHOOK`[] | yo'q | ≥ 1 ta |  |
| `recipients` | object | yo'q |  |  |
| `recipients.roles` | string[] | yo'q |  |  |
| `recipients.userIds` | string (uuid)[] | yo'q |  |  |
| `recipients.driverIds` | string (uuid)[] | yo'q |  |  |
| `recipients.subjectDriver` | boolean | yo'q |  |  |
| `throttle` | object | yo'q |  |  |
| `throttle.perDriverPerDay` | integer | yo'q | ≥ >True |  |
| `throttle.cooldownMin` | integer | yo'q | ≥ >True |  |
| `quietHours` | object | yo'q |  |  |
| `quietHours.from` | string | ha | pattern `^([01]\d|2[0-3]):[0-5]\d$` |  |
| `quietHours.to` | string | ha | pattern `^([01]\d|2[0-3]):[0-5]\d$` |  |
| `quietHours.timezone` | string | ha | 1–60 belgi |  |
| `enabled` | boolean | yo'q | default `true` |  |
| `mutedUntil` | string (date-time) | yo'q, null mumkin |  |  |

**Javob `200`:** 

```json
{
  "id": "alr_1",
  "enabled": false
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Alert rule not found. · `422` CHANNEL_NOT_AVAILABLE — SMS is not available yet.

---

### `DELETE /api/alert-rules/{id}`

**Nima qiladi:** Custom alert qoidasini o'chiradi (tizim qoidalari o'chirilmaydi).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-alert-rules', 'title': 'Settings · Alert rules', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `AlertRulesController_remove` · original: _Deletes a custom alert rule (system rules cannot be deleted)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "alr_2",
  "deleted": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Alert rule not found. · `422` ALERT_RULE_INVALID — System alert rules cannot be deleted.

---

### `POST /api/alert-rules/{id}/test`

**Nima qiladi:** Qoidaning o'z kanallari orqali chaqiruvchiga test bildirishnoma yuboradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-alert-rules', 'title': 'Settings · Alert rules', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `AlertRulesController_test` · original: _Sends a test notification through the rule's own channels to the caller. A disabled rule triggers nothing._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "triggered": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Alert rule not found. · `422` VALIDATION_FAILED — Request validation failed.

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

<a id="bolim-notification-channels"></a>

## Bildirishnoma kanallari

### `GET /api/notification-channels`

**Nima qiladi:** Tashkilot darajasidagi kanal sozlamalari (email, webhook).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-alert-rules', 'title': 'Settings · Alert rules', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `NotificationChannelsController_get` · original: _Org-level notification channel toggles (email, webhook)._

**Javob `200`:** 

```json
{
  "email": {
    "enabled": true
  },
  "webhook": {
    "enabled": false
  }
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/notification-channels`

**Nima qiladi:** Kanal sozlamalarini yangilaydi. O'chirilgan kanal barcha alert qoidalari uchun yetkazishni to'xtatadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-alert-rules', 'title': 'Settings · Alert rules', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `NotificationChannelsController_update` · original: _Updates org-level notification channel toggles. A disabled channel suppresses delivery for every alert rule._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `email` | object | yo'q |  |  |
| `email.enabled` | boolean | ha |  |  |
| `webhook` | object | yo'q |  |  |
| `webhook.enabled` | boolean | ha |  |  |
| `webhook.url` | string (uri) | yo'q |  |  |

**Javob `200`:** 

```json
{
  "email": {
    "enabled": true
  },
  "webhook": {
    "enabled": false
  }
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-integrations"></a>

## Integratsiyalar

### `POST /api/integrations/webhook/test`

**Nima qiladi:** Sozlangan webhook manziliga imzolangan test hodisa yuboradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-integrations', 'title': 'Settings · Integrations', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `WebhooksController_sendTest` · original: _Sends a signed test event to the configured webhook endpoint._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `eventType` | string | yo'q | ≥ 1 belgi, default `"test.ping"` |  |
| `payload` | object | yo'q | default `{}` |  |

**Javob `200`:** 

```json
{
  "id": "whd_1",
  "status": "QUEUED",
  "attempts": 0
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` INTEGRATION_NOT_CONFIGURED — No webhook endpoint is configured. · `422` WEBHOOK_DELIVERY_FAILED — The endpoint rejected the signed test event.

---

### `GET /api/integrations`

**Nima qiladi:** Ulangan integratsiyalar ro'yxati. Maxfiy maydonlar yashiriladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-integrations', 'title': 'Settings · Integrations', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `IntegrationsController_list` · original: _Lists configured integrations. Secret config fields are redacted._

**Javob `200`:** Secret config fields come back as `***`.

```json
[
  {
    "id": "int_1",
    "provider": "mcleod",
    "enabled": true,
    "status": "CONNECTED",
    "lastSyncAt": "2026-09-11T09:12:00.000Z",
    "config": {
      "baseUrl": "https://tms.example.com",
      "apiToken": "***"
    }
  }
]
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/integrations/catalog`

**Nima qiladi:** Integratsiyalar katalogi (Pacific Track, DAT, Geotab, Zapier va h.k.).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-integrations', 'title': 'Settings · Integrations', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `IntegrationsController_catalog` · original: _B-89 — marketplace catalog (every connectable provider, incl. Pacific Track, DAT, Geotab, Zapier). Declared before `:provider` so it is never swallowed._

**Javob `200`:** 

```json
[
  {
    "provider": "mcleod",
    "name": "McLeod",
    "description": "TMS load and dispatch sync.",
    "category": "TMS",
    "available": true
  },
  {
    "provider": "zapier",
    "name": "Zapier",
    "description": "Automate with 6,000+ apps.",
    "category": "Developer",
    "available": true
  }
]
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/integrations/{provider}`

**Nima qiladi:** Bitta integratsiya (maxfiy maydonlar yashirin).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-integrations', 'title': 'Settings · Integrations', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `IntegrationsController_get` · original: _Fetches one integration. Secret config fields are redacted._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `provider` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "int_1",
  "provider": "wex",
  "enabled": true,
  "status": "CONNECTED",
  "config": {
    "accountId": "4821",
    "apiKey": "***"
  }
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` INTEGRATION_NOT_CONFIGURED — This provider is not configured. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PUT /api/integrations/{provider}`

**Nima qiladi:** Provayder ulanishini yaratadi yoki qayta sozlaydi; maxfiy qiymatlar shifrlanadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-integrations', 'title': 'Settings · Integrations', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `IntegrationsController_upsert` · original: _Creates or reconfigures a provider connection; secrets are encrypted at rest._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `provider` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `enabled` | boolean | yo'q | default `true` |  |
| `config` | object | yo'q | default `{}` |  |

**Javob `200`:** 

```json
{
  "id": "int_1",
  "provider": "mcleod",
  "enabled": true,
  "status": "CONNECTED"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/integrations/{provider}`

**Nima qiladi:** Provayderni uzadi va saqlangan sozlama/maxfiy qiymatlarni o'chiradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-integrations', 'title': 'Settings · Integrations', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `IntegrationsController_disconnect` · original: _Disconnects a provider and drops its stored config/secrets._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `provider` | path | string | ha |  |  |

**Javob `200`:** Config and secrets are dropped; the row stays for the audit trail.

```json
{
  "id": "int_1",
  "provider": "mcleod",
  "enabled": false,
  "status": "DISCONNECTED"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` INTEGRATION_NOT_CONFIGURED — This provider is not configured. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-logs"></a>

## RODS loglar

### `GET /api/logs/{driverId}`

**Nima qiladi:** Bitta RODS kuni: grafik, yozuvlar, violation'lar, sertifikatsiya holati.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`
- **operationId:** `LogsController_getDay` · original: _One RODS day: grid, records, violations and certification state (§9, §23)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `driverId` | path | string | ha |  |  |
| `date` | query | string | yo'q | pattern `^\d{4}-\d{2}-\d{2}$` | RODS day (YYYY-MM-DD) in the driver's home terminal timezone. |

**Javob `200`:** 

```json
{
  "driverId": "drv_1",
  "date": "2026-09-10",
  "timezone": "America/New_York",
  "summary": {
    "drivingSec": 32400,
    "onDutySec": 7200,
    "offDutySec": 39600,
    "sleeperSec": 7200,
    "certified": false
  },
  "graph": [
    {
      "status": "OFF",
      "effective": "OFF",
      "startAt": "2026-09-10T04:00:00.000Z",
      "durationSec": 3600
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/logs/{driverId}/range`

**Nima qiladi:** Kunlar oralig'i bo'yicha qisqa xulosalar (max 62 kun).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`
- **operationId:** `LogsController_getRange` · original: _Daily summaries for a range of RODS days (max 62)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `driverId` | path | string | ha |  |  |
| `to` | query | string | ha | pattern `^\d{4}-\d{2}-\d{2}$` |  |
| `from` | query | string | ha | pattern `^\d{4}-\d{2}-\d{2}$` |  |

**Javob `200`:** 

```json
{
  "driverId": "drv_1",
  "from": "2026-09-03",
  "to": "2026-09-10",
  "days": [
    {
      "date": "2026-09-10",
      "drivingSec": 32400,
      "onDutySec": 7200,
      "certified": false,
      "violations": 2
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` RANGE_TOO_LARGE — The requested range exceeds 62 RODS days.

---

### `GET /api/logs/{driverId}/events`

**Nima qiladi:** Kunning barcha §395 yozuvlari, almashtirilgan (2), taklif (3) va rad etilgan (4) lar bilan — inspektor ko'radigan audit izi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`
- **operationId:** `LogsController_getEvents` · original: _Every §395 record of a RODS day, including superseded (2), proposed (3) and rejected (4) ones — the audit trail the inspector sees._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `driverId` | path | string | ha |  |  |
| `date` | query | string | yo'q | pattern `^\d{4}-\d{2}-\d{2}$` |  |

**Javob `200`:** Append-only audit trail: active (1), superseded (2), proposed (3) and rejected (4) records.

```json
{
  "driverId": "drv_1",
  "date": "2026-09-10",
  "events": [
    {
      "id": "evt_8801",
      "eventType": 1,
      "eventCode": 3,
      "eventSequenceId": 1042,
      "recordStatus": 2,
      "recordOrigin": 1,
      "dutyStatus": "ON",
      "occurredAt": "2026-09-10T18:26:58.000Z",
      "odometerMiles": 993590,
      "latitude": 38.02,
      "longitude": -84.5,
      "locationDescription": "1mi N KY Florence",
      "totalEngineHours": 4321.4,
      "checksumValid": true
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/logs/{driverId}/events`

**Nima qiladi:** YANGI yozuv taklif qiladi (recordStatus = 3, haydovchi qabul qilmaguncha hech narsaga ta'sir qilmaydi).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`
- **operationId:** `LogsController_proposeEvent` · original: _B-72 — proposes a NEW record (e.g. on a RODS day with no duty record yet). §395.30: stored inert with recordStatus = 3, counts toward nothing and is applied only when the driver accepts via edit-requests/:id/accept._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `driverId` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `status` | `OFF` \| `SB` \| `D` \| `ON` | ha |  |  |
| `proposedSpecial` | `NONE` \| `PC` \| `YM` | yo'q |  |  |
| `eventDateTime` | string (date-time) | ha |  |  |
| `endDateTime` | string (date-time) | yo'q |  |  |
| `location` | object | yo'q |  |  |
| `location.lat` | number | yo'q | -90–90 |  |
| `location.lon` | number | yo'q | -180–180 |  |
| `location.name` | string | yo'q | 1–120 belgi |  |
| `odometerMi` | integer | yo'q | 0–9999999 |  |
| `engineHours` | number | yo'q | 0–99999 |  |
| `annotation` | string | ha | 4–60 belgi |  |
| `notifyDriver` | boolean | yo'q | default `true` |  |

**Javob `201`:** Stored as an inert proposal (recordStatus = 3, applied = false). Audited as LOG_EVENT_PROPOSED; the driver is pushed unless notifyDriver = false.

```json
{
  "id": "9001",
  "driverId": "drv_1",
  "status": "PENDING",
  "kind": "INSERT",
  "proposedStatus": "ON",
  "proposedSpecial": "NONE",
  "eventDateTime": "2026-09-10T13:00:00.000Z",
  "endDateTime": "2026-09-10T14:30:00.000Z",
  "annotation": "Pre-trip inspection at the yard",
  "notifyDriver": true,
  "recordStatus": 3,
  "applied": false
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` DRIVING_TIME_IMMUTABLE — The proposed interval would overwrite recorded driving time (49 CFR §395.30(c)(2)).

---

### `GET /api/logs/{driverId}/edit-requests`

**Nima qiladi:** Carrier tahrir takliflari va haydovchi ularga qanday javob bergani.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`
- **operationId:** `LogsController_listEditRequests` · original: _Carrier edit proposals and how the driver answered them._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `driverId` | path | string | ha |  |  |
| `status` | query | `PENDING` \| `ACCEPTED` \| `REJECTED` \| `ALL` | yo'q |  |  |
| `from` | query | string | yo'q | pattern `^\d{4}-\d{2}-\d{2}$` |  |
| `to` | query | string | yo'q | pattern `^\d{4}-\d{2}-\d{2}$` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "edt_1",
      "date": "2026-09-10",
      "status": "PENDING",
      "requestedBy": "usr_1",
      "reason": "Wrong duty status",
      "createdAt": "2026-09-11T15:41:00.000Z"
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/logs/{driverId}/edit-requests`

**Nima qiladi:** Haydovchi yozuviga tahrir taklif qiladi (§395.30). Haydovchi qabul qilmaguncha hech narsa o'zgarmaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`
- **operationId:** `LogsController_createEditRequest` · original: _Proposes an edit to a driver record (§395.30). The proposal is INERT: it is stored with recordStatus = 3 and changes nothing until the driver accepts._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `driverId` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `originalEventId` | string | ha | pattern `^\d+$` |  |
| `proposedStatus` | `OFF` \| `SB` \| `D` \| `ON` | ha |  |  |
| `proposedSpecial` | `NONE` \| `PC` \| `YM` | yo'q |  |  |
| `proposedStart` | string (date-time) | ha |  |  |
| `proposedEnd` | string (date-time) | yo'q |  |  |
| `location` | object | yo'q |  |  |
| `location.lat` | number | yo'q | -90–90 |  |
| `location.lon` | number | yo'q | -180–180 |  |
| `location.name` | string | yo'q | 1–120 belgi |  |
| `odometerMi` | integer | yo'q | 0–9999999 |  |
| `engineHours` | number | yo'q | 0–99999 |  |
| `reason` | string | ha | 4–60 belgi |  |
| `notifyDriver` | boolean | yo'q | default `true` |  |

**Javob `201`:** Stored as an inert proposal (recordStatus = 3). Nothing in the log changes until the driver accepts.

```json
{
  "id": "edt_9",
  "driverId": "drv_1",
  "status": "PENDING",
  "date": "2026-09-10",
  "reason": "Driver forgot to switch to On duty while loading at shipper #4821.",
  "proposed": {
    "status": "ON",
    "startAt": "2026-09-10T18:26:58.000Z",
    "endAt": "2026-09-10T19:30:00.000Z"
  },
  "proposedSpecial": "YM",
  "notifyDriver": true,
  "recordStatus": 3,
  "applied": false,
  "createdAt": "2026-09-11T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` DRIVING_TIME_IMMUTABLE — Driving time can never be shortened, deleted or restatused (49 CFR §395.30).

---

### `POST /api/logs/{driverId}/certify`

**Nima qiladi:** RODS kunlarini sertifikatlaydi. Back-office uchun `hosCertifyOnBehalf = FULL` kerak va audit qilinadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`
- **operationId:** `LogsController_certify` · original: _Certifies one or more RODS days (§9.2). A driver certifies their own log; a back-office user needs hosCertifyOnBehalf = FULL and the action is always audited._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `driverId` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `dates` | string[] | ha | 1–31 ta |  |
| `signatureImageId` | string | yo'q | ≤ 200 belgi |  |
| `driverId` | string (uuid) | yo'q |  |  |
| `clientId` | string (uuid) | yo'q |  |  |

**Javob `201`:** Certification is the driver signature; on-behalf certification is always written to the audit log.

```json
{
  "driverId": "drv_1",
  "certified": [
    {
      "date": "2026-09-10",
      "certifiedAt": "2026-09-11T15:41:00.000Z",
      "certifiedBy": "usr_1",
      "onBehalf": true,
      "signatureCount": 1
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Certifying on behalf of a driver requires hosCertifyOnBehalf = FULL. · `404` DRIVER_NOT_FOUND — Driver not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-dtc"></a>

## DTC (nosozlik kodlari)

### `GET /api/vehicles/{id}/dtc` ♻️ O'ZGARGAN

**Nima qiladi:** Unit nosozlik kodlari (DTC), default faqat ochiqlari. 🆕 qatorda `code`, `bus`, `milOn`, `conversionMethod`, `active` (J1939 SPN/FMI, J1708 SID/PID+FMI, OBD-II kod).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `DtcController_list` · original: _Lists DTCs captured for a unit — J1939 SPN/FMI, J1708 SID/PID+FMI (`code`), OBD-II `code`; open codes by default (TZ §5.7, PT SDK 6.11)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |
| `includeCleared` | query | `true` yoki `false` | yo'q |  |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "dtc_1",
      "vehicleId": "veh_1",
      "spn": 100,
      "fmi": 1,
      "code": null,
      "bus": "J1939",
      "milOn": true,
      "conversionMethod": 0,
      "active": null,
      "occurrence": 3,
      "source": "0",
      "description": null,
      "firstSeenAt": "2026-09-10T12:00:00.000Z",
      "lastSeenAt": "2026-09-11T08:00:00.000Z",
      "clearedAt": null
    },
    {
      "id": "dtc_2",
      "vehicleId": "veh_1",
      "spn": null,
      "fmi": 3,
      "code": "SID 254",
      "bus": "J1708",
      "milOn": false,
      "conversionMethod": null,
      "active": true,
      "occurrence": 1,
      "source": null,
      "description": null,
      "firstSeenAt": "2026-09-11T08:00:00.000Z",
      "lastSeenAt": "2026-09-11T08:00:00.000Z",
      "clearedAt": null
    },
    {
      "id": "dtc_3",
      "vehicleId": "veh_1",
      "spn": null,
      "fmi": null,
      "code": "P0301",
      "bus": "OBD_II",
      "milOn": true,
      "conversionMethod": null,
  …
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-messaging"></a>

## Xabarlar

### `GET /api/conversations`

**Nima qiladi:** Chaqiruvchining suhbatlari.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/messages', 'title': 'Messages', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)'}`
- **operationId:** `MessagingController_listConversations` · original: _Lists the caller's conversations._

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "cnv_1",
      "type": "DIRECT",
      "lastMessageAt": "2026-09-11T15:00:00.000Z"
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/conversations`

**Nima qiladi:** Berilgan ishtirokchilar bilan shaxsiy yoki guruh suhbati ochadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/messages', 'title': 'Messages', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)'}`
- **operationId:** `MessagingController_createConversation` · original: _Opens a direct or group conversation with the given participants._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `type` | `DIRECT` \| `GROUP` \| `BROADCAST` | yo'q |  |  |
| `title` | string | yo'q | ≤ 200 belgi |  |
| `driverIds` | string (uuid)[] | yo'q | ≤ 500 ta, default `[]` |  |
| `userIds` | string (uuid)[] | yo'q | ≤ 500 ta, default `[]` |  |

**Javob `201`:** 

```json
{
  "id": "cnv_2",
  "type": "DIRECT"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/conversations/{id}/messages`

**Nima qiladi:** Suhbatdagi xabarlar (chaqiruvchi ishtirokchi bo'lishi shart).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/messages', 'title': 'Messages', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)'}`
- **operationId:** `MessagingController_listMessages` · original: _Lists messages in a conversation (caller must be a participant)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |
| `limit` | query | integer | yo'q | 1–200, default `50` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "msg_1",
      "body": "On schedule.",
      "sentAt": "2026-09-11T15:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 50,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Not a participant of this conversation. · `404` NOT_FOUND — Conversation not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/conversations/{id}/messages`

**Nima qiladi:** Suhbatga xabar yuboradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/messages', 'title': 'Messages', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)'}`
- **operationId:** `MessagingController_sendMessage` · original: _Sends a message into a conversation._

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

**Javob `201`:** 

```json
{
  "id": "msg_2",
  "body": "Confirmed.",
  "sentAt": "2026-09-11T15:05:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Not a participant of this conversation. · `404` NOT_FOUND — Conversation not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/conversations/{id}/read`

**Nima qiladi:** Chaqiruvchi uchun suhbatni hozirgacha o'qilgan qiladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/messages', 'title': 'Messages', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)'}`
- **operationId:** `MessagingController_markRead` · original: _Marks the caller's own copy of a conversation read up to now (§20 B-67)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "conversationId": "cnv_1",
  "lastReadAt": "2026-09-24T15:05:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Not a participant of this conversation. · `404` NOT_FOUND — Conversation not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/messages/broadcast`

**Nima qiladi:** Bitta xabarni ko'p haydovchiga yuboradi (har haydovchiga alohida suhbat).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/messages', 'title': 'Messages', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)'}`
- **operationId:** `MessagingController_broadcast` · original: _Broadcasts one message to many drivers (one conversation + delivery per driver)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `title` | string | yo'q | ≤ 200 belgi |  |
| `body` | string | ha | 1–2000 belgi |  |
| `driverIds` | string (uuid)[] | ha | 1–1000 ta |  |

**Javob `200`:** 

```json
{
  "sent": 2,
  "deliveries": [
    {
      "conversationId": "cnv_3",
      "messageId": "msg_3",
      "driverId": "drv_1"
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-devices"></a>

## ELD qurilmalar

### `GET /api/devices` ♻️ O'ZGARGAN

**Nima qiladi:** PT30/PT40 qurilmalar ro'yxati: BLE holati, firmware. 🆕 SDK TrackerInfo maydonlari (productName, bleFirmware, imei, reportedVin, sdkVersion, appPlatform, connectionType, busType, lastInfoAt), harsh/NOBLE sozlamalari va `systemVars`.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-eld-devices', 'title': 'Settings · ELD devices', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `DevicesController_list` · original: _Lists PT30/PT40 devices with connected/offline BLE state, firmware, PT SDK 6.11 TrackerInfo and system variables._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `vehicleId` | query | string (uuid) | yo'q |  | B-35 — join a single unit's device (device<->vehicle binding lives only on Device.vehicleId). |
| `bleState` | query | `CONNECTED` \| `OUT_OF_RANGE` \| `DISCONNECTED` | yo'q |  |  |
| `status` | query | `UNASSIGNED` \| `ASSIGNED` \| `FAULTY` \| `RETIRED` | yo'q |  |  |
| `q` | query | string | yo'q | ≤ 200 belgi |  |
| `sort` | query | string | yo'q | ≤ 60 belgi |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "dev_1",
      "serial": "PT30_A86E",
      "model": "PT30",
      "bleState": "CONNECTED",
      "firmware": "L108",
      "firmwareOutdated": false,
      "productName": "PT30",
      "bleFirmware": "1.4.2",
      "imei": null,
      "reportedVin": "1FUJGLDR7CLBP8834",
      "sdkVersion": "6.11.1",
      "appPlatform": "ANDROID",
      "connectionType": "BLE",
      "busType": "J1939",
      "lastInfoAt": "2026-10-10T12:00:00.000Z",
      "periodicConnectedSec": 30,
      "periodicNoBleSec": 30,
      "periodicDisconnectedMin": 30,
      "harshAccelMg": 0,
      "harshBrakeMg": 450,
      "harshCornerMg": 0,
      "systemVars": {
        "PERIODIC_EVENT_GAP": 30,
        "PERIODIC_EVENT_GAP_NOBLE": 30,
        "EVENTS_STORED": 1,
        "DRIVING_ACCL": 0,
        "DRIVING_BRAKING": 450,
        "DRIVING_CORNERING": 0,
        "HSI_MODE": 1
      }
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/devices` ♻️ O'ZGARGAN

**Nima qiladi:** PT30/PT40 qurilmani ro'yxatga oladi. 🆕 ixtiyoriy `periodicNoBleSec` 10–480 s, `harshAccelMg`/`harshBrakeMg`/`harshCornerMg` 0–8192 mG (0 = o'chiq).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-eld-devices', 'title': 'Settings · ELD devices', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `DevicesController_create` · original: _Registers a PT30/PT40 device (TZ §5.4). Optional PT SDK targets: `periodicNoBleSec` 10–480 s, `harshAccelMg`/`harshBrakeMg`/`harshCornerMg` 0–8192 mG (0 = off)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `serial` | string | ha | 1–60 belgi |  |
| `bleMacAddress` | string | yo'q | ≤ 30 belgi |  |
| `model` | `PT30` \| `PT40` | yo'q |  |  |
| `firmware` | string | yo'q | ≤ 20 belgi |  |
| `periodicConnectedSec` | integer | yo'q | 2–7200, default `30` |  |
| `periodicDisconnectedMin` | integer | yo'q | 1–480, default `30` |  |
| `periodicNoBleSec` | integer | yo'q | 10–480, default `30` |  |
| `harshAccelMg` | integer | yo'q | 0–8192, default `0` |  |
| `harshBrakeMg` | integer | yo'q | 0–8192, default `0` |  |
| `harshCornerMg` | integer | yo'q | 0–8192, default `0` |  |
| `autoFirmware` | boolean | yo'q | default `true` |  |
| `shareDiagnostics` | boolean | yo'q | default `true` |  |

**Javob `201`:** 

```json
{
  "id": "dev_9",
  "serial": "PT30_1C4F",
  "model": "PT30",
  "status": "UNASSIGNED",
  "bleState": "DISCONNECTED"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `409` CONFLICT — A device with this serial is already registered. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/devices/export`

**Nima qiladi:** Barcha qurilmalarni `POST /devices/import` formatida eksport qiladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-eld-devices', 'title': 'Settings · ELD devices', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `DevicesController_export` · original: _Exports all devices as the same shape `POST /devices/import` accepts._

**Javob `200`:** Every device in the import payload shape.

```json
{
  "devices": [
    {
      "serial": "PT30_A86E",
      "model": "PT30",
      "bleMac": "A4:C1:38:12:9F:6E",
      "firmwareVersion": "L108"
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/devices/{id}` ♻️ O'ZGARGAN

**Nima qiladi:** Bitta qurilma. 🆕 yangi TrackerInfo maydonlari va `systemVars` bilan.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-eld-devices', 'title': 'Settings · ELD devices', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `DevicesController_get` · original: _Gets one device._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "dev_1",
  "serial": "PT30_A86E",
  "model": "PT30",
  "status": "ASSIGNED",
  "vehicleId": "veh_1",
  "bleState": "CONNECTED",
  "firmware": "L108",
  "firmwareOutdated": false,
  "lastSeenAt": "2026-09-11T15:41:00.000Z",
  "productName": "PT30",
  "bleFirmware": "1.4.2",
  "imei": null,
  "reportedVin": "1FUJGLDR7CLBP8834",
  "sdkVersion": "6.11.1",
  "appPlatform": "ANDROID",
  "connectionType": "BLE",
  "busType": "J1939",
  "lastInfoAt": "2026-10-10T12:00:00.000Z",
  "periodicConnectedSec": 30,
  "periodicNoBleSec": 30,
  "periodicDisconnectedMin": 30,
  "harshAccelMg": 0,
  "harshBrakeMg": 450,
  "harshCornerMg": 0,
  "systemVars": {
    "PERIODIC_EVENT_GAP": 30,
    "PERIODIC_EVENT_GAP_NOBLE": 30,
    "EVENTS_STORED": 1,
    "DRIVING_ACCL": 0,
    "DRIVING_BRAKING": 450,
    "DRIVING_CORNERING": 0,
    "HSI_MODE": 1
  }
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEVICE_NOT_FOUND — Device not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/devices/{id}` ♻️ O'ZGARGAN

**Nima qiladi:** Qurilmani tahrirlaydi (BLE MAC, periodik sozlamalar, holat). 🆕 `periodicNoBleSec`, `harshAccelMg`, `harshBrakeMg`, `harshCornerMg`.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-eld-devices', 'title': 'Settings · ELD devices', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `DevicesController_update` · original: _Edits a device (BLE MAC, PE/PN settings, status, PT SDK system-variable targets `periodicNoBleSec` 10–480 s and `harshAccelMg`/`harshBrakeMg`/`harshCornerMg` 0–8192 mG)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `serial` | string | yo'q | 1–60 belgi |  |
| `bleMacAddress` | string | yo'q | ≤ 30 belgi |  |
| `model` | `PT30` \| `PT40` | yo'q |  |  |
| `firmware` | string | yo'q | ≤ 20 belgi |  |
| `periodicConnectedSec` | integer | yo'q | 2–7200, default `30` |  |
| `periodicDisconnectedMin` | integer | yo'q | 1–480, default `30` |  |
| `periodicNoBleSec` | integer | yo'q | 10–480, default `30` |  |
| `harshAccelMg` | integer | yo'q | 0–8192, default `0` |  |
| `harshBrakeMg` | integer | yo'q | 0–8192, default `0` |  |
| `harshCornerMg` | integer | yo'q | 0–8192, default `0` |  |
| `autoFirmware` | boolean | yo'q | default `true` |  |
| `shareDiagnostics` | boolean | yo'q | default `true` |  |
| `status` | `UNASSIGNED` \| `ASSIGNED` \| `FAULTY` \| `RETIRED` | yo'q |  |  |

**Javob `200`:** 

```json
{
  "id": "dev_1",
  "serial": "PT30_A86E",
  "bleMac": "A4:C1:38:12:9F:6E",
  "status": "ASSIGNED"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEVICE_NOT_FOUND — Device not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/devices/{id}`

**Nima qiladi:** Qurilmani iste'moldan chiqaradi (RETIRED, ajratiladi). To'liq o'chirmaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-eld-devices', 'title': 'Settings · ELD devices', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `DevicesController_remove` · original: _Retires a device (status -> RETIRED, unpaired). Never hard-deletes — see bugs.md B-009._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** Retired, never hard-deleted (bugs.md B-009).

```json
{
  "id": "dev_1",
  "status": "RETIRED",
  "vehicleId": null
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEVICE_NOT_FOUND — Device not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/devices/{id}/diagnostics`

**Nima qiladi:** Qurilmaning oxirgi ulanish/GPS diagnostikasi (yozilgan holatdan, jonli so'rov emas).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-eld-devices', 'title': 'Settings · ELD devices', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `DevicesController_diagnostics` · original: _Reads the device's latest connectivity/GPS diagnostics (derived from recorded status, not a live round-trip). B-8._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** An unresponsive device is `responded: false`, not an error.

```json
{
  "signalStrength": "good",
  "gpsLock": true,
  "responded": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEVICE_NOT_FOUND — Device not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/devices/import` ♻️ O'ZGARGAN

**Nima qiladi:** Qurilmalarni ommaviy import qiladi; `serial` bo'yicha upsert. 🆕 yangi sozlama maydonlari qabul qilinadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-eld-devices', 'title': 'Settings · ELD devices', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `DevicesController_import` · original: _Bulk-imports devices; upserts by `serial`._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `devices` | object[] | ha | 1–1000 ta |  |
| `devices[].serial` | string | ha | 1–60 belgi |  |
| `devices[].bleMacAddress` | string | yo'q | ≤ 30 belgi |  |
| `devices[].model` | `PT30` \| `PT40` | yo'q |  |  |
| `devices[].firmware` | string | yo'q | ≤ 20 belgi |  |
| `devices[].periodicConnectedSec` | integer | yo'q | 2–7200, default `30` |  |
| `devices[].periodicDisconnectedMin` | integer | yo'q | 1–480, default `30` |  |
| `devices[].periodicNoBleSec` | integer | yo'q | 10–480, default `30` |  |
| `devices[].harshAccelMg` | integer | yo'q | 0–8192, default `0` |  |
| `devices[].harshBrakeMg` | integer | yo'q | 0–8192, default `0` |  |
| `devices[].harshCornerMg` | integer | yo'q | 0–8192, default `0` |  |
| `devices[].autoFirmware` | boolean | yo'q | default `true` |  |
| `devices[].shareDiagnostics` | boolean | yo'q | default `true` |  |

**Javob `201`:** 

```json
{
  "imported": 5,
  "updated": 1,
  "failed": []
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` IMPORT_FAILED — One or more rows could not be imported.

---

### `PATCH /api/devices/{id}/firmware`

**Nima qiladi:** Qurilma xabar qilgan firmware versiyasini yozadi (L108 dan past bo'lsa ogohlantiradi).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-eld-devices', 'title': 'Settings · ELD devices', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `DevicesController_updateFirmware` · original: _Records a firmware version reported by the device (warns below L108, TZ §5.4)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `firmware` | string | ha | 1–20 belgi |  |

**Javob `200`:** `firmwareOutdated` is true below L108 (TZ §5.4).

```json
{
  "id": "dev_1",
  "firmwareVersion": "L107",
  "firmwareOutdated": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEVICE_NOT_FOUND — Device not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/devices/{id}/ble-status`

**Nima qiladi:** Back-office tomonidan BLE holatini qo'lda o'zgartirish (ilova o'zi /ingest/ble-state orqali yuboradi).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-eld-devices', 'title': 'Settings · ELD devices', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `DevicesController_updateBleStatus` · original: _Back-office override of the BLE connection state (CONNECTED/OUT_OF_RANGE/DISCONNECTED). The driver app itself reports BLE state via POST /ingest/ble-state — this endpoint is for manual back-office correction only (MB-23)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `bleState` | `CONNECTED` \| `OUT_OF_RANGE` \| `DISCONNECTED` | ha |  |  |
| `storedEventsCount` | integer | yo'q | ≥ 0 |  |

**Javob `200`:** 

```json
{
  "id": "dev_1",
  "bleState": "OUT_OF_RANGE",
  "lastHeartbeatAt": "2026-09-11T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEVICE_NOT_FOUND — Device not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/devices/{id}/pair`

**Nima qiladi:** Qurilmani unitga juftlaydi. Bitta unitga bitta qurilma.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-eld-devices', 'title': 'Settings · ELD devices', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `DevicesController_pair` · original: _Pairs a device to a unit. One device per unit (hard rule)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `vehicleId` | string (uuid) | ha |  |  |

**Javob `201`:** 

```json
{
  "id": "dev_1",
  "serial": "PT30_A86E",
  "status": "ASSIGNED",
  "vehicleId": "veh_1"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEVICE_NOT_FOUND — Device not found. · `409` DEVICE_ALREADY_PAIRED — This unit already has a paired device — one device per unit. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/devices/{id}/unpair`

**Nima qiladi:** Qurilmani unitdan ajratadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-eld-devices', 'title': 'Settings · ELD devices', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28'}`
- **operationId:** `DevicesController_unpair` · original: _Unpairs a device from its unit._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `201`:** 

```json
{
  "id": "dev_1",
  "serial": "PT30_A86E",
  "status": "UNASSIGNED",
  "vehicleId": null
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEVICE_NOT_FOUND — Device not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-co-driver-pairings"></a>

## Co-driver juftliklari

### `GET /api/co-driver-pairings`

**Nima qiladi:** Co-driver juftliklari ro'yxati (unit yoki haydovchi bo'yicha, faqat faollar).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`, `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`
- **operationId:** `CoDriverPairingsController_list` · original: _Lists co-driver pairings (team driving), optionally scoped to a unit or driver, active-only._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `active` | query | `true` \| `false` | yo'q |  |  |
| `driverId` | query | string (uuid) | yo'q |  |  |
| `vehicleId` | query | string (uuid) | yo'q |  |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "pair_1",
      "primaryDriverId": "drv_1",
      "coDriverId": "drv_2",
      "vehicleId": "veh_1",
      "startedAt": "2026-09-24T00:00:00.000Z",
      "endedAt": null
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/co-driver-pairings`

**Nima qiladi:** Unitda co-driver juftligini boshlaydi (team driving).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`, `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`
- **operationId:** `CoDriverPairingsController_create` · original: _Starts a co-driver pairing on a unit (team driving, TZ §5.3 hard rule — never a plain Driver column)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `primaryDriverId` | string (uuid) | ha |  |  |
| `coDriverId` | string (uuid) | ha |  |  |
| `vehicleId` | string (uuid) | ha |  |  |
| `startedAt` | string (date-time) | yo'q |  |  |

**Javob `201`:** 

```json
{
  "id": "pair_1",
  "primaryDriverId": "drv_1",
  "coDriverId": "drv_2",
  "vehicleId": "veh_1",
  "startedAt": "2026-09-24T00:00:00.000Z",
  "endedAt": null
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `409` CONFLICT — This co-driver already has an active pairing on this unit. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/co-driver-pairings/{id}/end`

**Nima qiladi:** Faol co-driver juftligini tugatadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/vehicle-add', 'title': 'Add vehicle', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.9'}`, `{'id': 'web/drivers', 'title': 'Drivers', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.11'}`
- **operationId:** `CoDriverPairingsController_end` · original: _Ends an active co-driver pairing._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `201`:** 

```json
{
  "id": "pair_1",
  "endedAt": "2026-09-24T12:00:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` CO_DRIVER_PAIRING_NOT_FOUND — Co-driver pairing not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-unidentified"></a>

## Unidentified driving

### `GET /api/unidentified`

**Nima qiladi:** Unidentified driving segmentlari ro'yxati.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`, `{'id': 'web/fleet-dashboard', 'title': 'Fleet Dashboard', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5'}`
- **operationId:** `UnidentifiedController_list` · original: _Lists unidentified driving segments (§5.9)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `status` | query | `PENDING` \| `PENDING_CONFIRMATION` \| `ASSIGNED` \| `REJECTED` \| `ANNOTATED` \| `ALL` | yo'q | default `"PENDING"` |  |
| `vehicleId` | query | string (uuid) | yo'q |  |  |
| `from` | query | string (date-time) | yo'q |  |  |
| `to` | query | string (date-time) | yo'q |  |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "seg_1",
      "vehicleId": "veh_1",
      "durationSec": 1800,
      "distanceMi": 21,
      "status": "PENDING",
      "fromStoredEvents": true
    }
  ],
  "total": 1,
  "page": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/unidentified/{id}`

**Nima qiladi:** Bitta segment va uning ortidagi §395 yozuvlari.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`, `{'id': 'web/fleet-dashboard', 'title': 'Fleet Dashboard', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5'}`
- **operationId:** `UnidentifiedController_get` · original: _One segment with the §395 records behind it (never deleted, §23)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "seg_1",
  "vehicleId": "veh_1",
  "status": "PENDING",
  "durationSec": 1800,
  "distanceMi": 21,
  "fromStoredEvents": true,
  "events": [
    {
      "id": "evt_7701",
      "eventSequenceId": 981,
      "recordOrigin": 1,
      "dutyStatus": "D",
      "occurredAt": "2026-09-10T12:30:00.000Z",
      "odometerMiles": 993218
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Unidentified segment not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/unidentified/{id}/assign`

**Nima qiladi:** Segmentni haydovchiga biriktiradi (ASSIGNED, audit). `requireDriverConfirmation` bilan haydovchi tasdig'i so'raladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`, `{'id': 'web/fleet-dashboard', 'title': 'Fleet Dashboard', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5'}`
- **operationId:** `UnidentifiedController_assign` · original: _Assigns the segment to a driver: status ASSIGNED, assignedById/At set, recordOrigin stays 1, AuditLog entry UNIDENTIFIED_ASSIGNED. With requireDriverConfirmation = true (B-83) nothing is attributed yet: status PENDING_CONFIRMATION, the driver is asked in the app (AuditLog UNIDENTIFIED_CONFIRMATION_REQUESTED) and the records move to their log only when they confirm._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `driverId` | string (uuid) | ha |  |  |
| `annotation` | string | yo'q | 4–60 belgi |  |
| `requireDriverConfirmation` | boolean | yo'q |  |  |

**Javob `201`:** recordOrigin stays 1 forever (§23) and the assignment is audited as UNIDENTIFIED_ASSIGNED.

```json
{
  "id": "seg_1",
  "status": "ASSIGNED",
  "driverId": "drv_1",
  "assignedById": "usr_1",
  "assignedAt": "2026-09-11T15:41:00.000Z",
  "recordOrigin": 1,
  "eventCount": 4
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Unidentified segment not found. · `409` UNIDENTIFIED_ALREADY_ASSIGNED — This segment is already assigned to a driver. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/unidentified/{id}/annotate`

**Nima qiladi:** Segmentga izoh qo'shadi (max 60 belgi).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`, `{'id': 'web/fleet-dashboard', 'title': 'Fleet Dashboard', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5'}`
- **operationId:** `UnidentifiedController_annotate` · original: _Annotates the segment (max 60 chars, Appendix A)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `annotation` | string | ha | 4–60 belgi |  |

**Javob `201`:** Annotation is capped at 60 characters (Appendix A).

```json
{
  "id": "seg_1",
  "status": "ANNOTATED",
  "annotation": "Yard move by shop tech",
  "annotatedById": "usr_1"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Unidentified segment not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/unidentified/{id}/reject`

**Nima qiladi:** Biriktirishni rad etadi: yozuvlar pool'ga qaytadi (recordOrigin = 4, driverId = null). Hech narsa o'chirilmaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`, `{'id': 'web/fleet-dashboard', 'title': 'Fleet Dashboard', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5'}`
- **operationId:** `UnidentifiedController_reject` · original: _Rejects the assignment: the records go back to the pool with recordOrigin = 4 and driverId = null. Nothing is deleted._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `reason` | string | yo'q | 4–60 belgi |  |

**Javob `201`:** Records return to the pool with recordOrigin = 4 and driverId = null. Nothing is ever deleted (§23).

```json
{
  "id": "seg_1",
  "status": "REJECTED",
  "driverId": null,
  "recordOrigin": 4,
  "eventCount": 4
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Unidentified segment not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-violations"></a>

## HOS violation'lar

### `GET /api/violations`

**Nima qiladi:** Flot HOS violation'lari (default status=OPEN), haydovchi ismi va unit bilan.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/fleet-dashboard', 'title': 'Fleet Dashboard', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5'}`, `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`
- **operationId:** `ViolationsController_list` · original: _Fleet HOS violation list (default status=OPEN) with driver name and unit._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `window` | query | `24h` \| `7d` \| `30d` | yo'q |  |  |
| `from` | query | string (date-time) | yo'q |  |  |
| `to` | query | string (date-time) | yo'q |  |  |
| `driverId` | query | string (uuid) | yo'q |  |  |
| `type` | query | `DRIVING_11` \| `SHIFT_14` \| `BREAK_30` \| `CYCLE_70` \| `CYCLE_60` \| `FORM_MANNER` | yo'q |  |  |
| `status` | query | `OPEN` \| `RESOLVED` \| `AUTO_CLEARED` \| `ALL` | yo'q | default `"OPEN"` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "vio_1",
      "driverId": "drv_1",
      "dailyLogId": "dl_1",
      "logDate": "2026-09-14",
      "type": "DRIVING_11",
      "occurredAt": "2026-09-14T14:26:00.000Z",
      "exceededBySec": 1560,
      "detail": "Driving 11h26m",
      "status": "OPEN",
      "resolvedAt": null,
      "resolvedById": null,
      "resolutionNote": null,
      "severity": "VIOLATION",
      "driverName": "John Smith",
      "vehicleId": "veh_1",
      "unitNumber": "101",
      "event": "11-hour driving limit exceeded",
      "locationLabel": "1.04 mi W of Harrisburg, OH",
      "date": "2026-09-14"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 25,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/violations/{id}/resolve`

**Nima qiladi:** OPEN violation'ni 4–60 belgilik izoh bilan yopadi. Audit qilinadi; RODS yozuvlari o'zgarmaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/fleet-dashboard', 'title': 'Fleet Dashboard', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5'}`, `{'id': 'web/hos-logs', 'title': 'Hours of Service · Driver log', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.13'}`
- **operationId:** `ViolationsController_resolve` · original: _Resolves an OPEN violation with a 4-60 char note. Audited as VIOLATION_RESOLVED; RODS records are never changed._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `resolutionNote` | string | ha | 4–60 belgi |  |

**Javob `201`:** 

```json
{
  "id": "vio_1",
  "status": "RESOLVED",
  "resolvedAt": "2026-09-14T15:41:00.000Z",
  "resolutionNote": "Adverse weather, dispatcher confirmed"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Violation not found. · `409` CONFLICT — Only an OPEN violation can be resolved. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-dvir"></a>

## DVIR

### `GET /api/dvir`

**Nima qiladi:** Topshirilgan DVIR'lar ro'yxati.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `DvirAdminController_list` · original: _Lists submitted DVIRs (TZ §5.10 "DVIR & Maintenance" screen)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `to` | query | string (date) | yo'q |  | B-47 — YYYY-MM-DD, inclusive. |
| `from` | query | string (date) | yo'q |  | B-47 — YYYY-MM-DD, inclusive. |
| `repairStatus` | query | `NOT_REQUIRED` \| `PENDING` \| `REPAIRED` \| `DEFERRED` | yo'q |  |  |
| `driverId` | query | string (uuid) | yo'q |  |  |
| `vehicleId` | query | string (uuid) | yo'q |  |  |
| `sort` | query | string | yo'q | ≤ 60 belgi |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "dvir_1",
      "driverId": "drv_1",
      "vehicleId": "veh_1",
      "type": "PRE_TRIP",
      "vehicleCondition": "DEFECTS_FOUND",
      "repairStatus": "PENDING"
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/dvir/compliance`

**Nima qiladi:** Sana oralig'ida kutilgan va topshirilgan PRE_TRIP DVIR'lar (W-14 compliance).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `DvirAdminController_compliance` · original: _B-47 — expected vs submitted PRE_TRIP DVIRs across the active fleet for a date range (W-14 compliance chip / missing rows). Declared before `:id` so it is never swallowed._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `to` | query | string (date) | ha |  | YYYY-MM-DD, inclusive. |
| `from` | query | string (date) | ha |  | YYYY-MM-DD, inclusive. |

**Javob `200`:** 

```json
{
  "expected": 60,
  "submitted": 57,
  "compliancePct": 95,
  "missing": [
    {
      "vehicleId": "veh_1",
      "unitNumber": "110",
      "date": "2026-09-20"
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/dvir/{id}`

**Nima qiladi:** Bitta DVIR, defektlari va rasmlari bilan.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `DvirAdminController_get` · original: _Gets one DVIR with its defects and photos._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "dvir_1",
  "vehicleId": "veh_1",
  "defects": [
    {
      "id": "def_1",
      "part": "TRUCK",
      "severity": "CRITICAL",
      "status": "OPEN"
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DVIR_NOT_FOUND — DVIR not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/dvir/{id}/pdf`

**Nima qiladi:** Bitta DVIR'ni §396.11 PDF qilib beradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `DvirAdminController_getPdf` · original: _B-75 — renders one DVIR to a §396.11 PDF: inspection record, defects and both signatures. Declared before any other :id sub-route so it is never swallowed._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** Raw application/pdf bytes (not wrapped in the success envelope).

```json
"%PDF-1.7 ..."
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DVIR_NOT_FOUND — DVIR not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/dvir/{id}/mechanic-signoff`

**Nima qiladi:** DVIR defektlari bo'yicha mexanik ko'rigini yozadi (§396.13).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `DvirAdminController_mechanicSignOff` · original: _Records the mechanic review of a DVIR's defects (TZ §396.13)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `mechanicName` | string | ha | 1–120 belgi |  |
| `mechanicNote` | string | yo'q | ≤ 500 belgi |  |
| `repairStatus` | `NOT_REQUIRED` \| `PENDING` \| `REPAIRED` \| `DEFERRED` | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "dvir_1",
  "mechanicName": "J. Alvarez",
  "repairStatus": "REPAIRED",
  "mechanicSignedAt": "2026-09-11T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DVIR_NOT_FOUND — DVIR not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/dvir/{id}/next-driver-review`

**Nima qiladi:** Keyingi haydovchi oldingi DVIR mexanik xulosasini ko'rganini belgilaydi (§396.13).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `DvirAdminController_nextDriverReview` · original: _Marks that the next driver reviewed the prior DVIR's mechanic sign-off (TZ §396.13)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `reviewedAt` | string (date-time) | yo'q |  |  |

**Javob `200`:** 

```json
{
  "id": "dvir_1",
  "nextDriverReviewedAt": "2026-09-11T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DVIR_NOT_FOUND — DVIR not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-defects"></a>

## Defektlar

### `GET /api/defects`

**Nima qiladi:** DVIR'lardan kelgan defektlar ro'yxati.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `DefectsController_list` · original: _Lists defects raised on DVIRs._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `assigneeId` | query | string (uuid) | yo'q |  |  |
| `outOfService` | query | boolean | yo'q |  |  |
| `severity` | query | `MINOR` \| `MAJOR` \| `CRITICAL` | yo'q |  |  |
| `status` | query | `OPEN` \| `IN_PROGRESS` \| `REPAIRED` \| `DEFERRED` | yo'q |  |  |
| `vehicleId` | query | string (uuid) | yo'q |  |  |
| `sort` | query | string | yo'q | ≤ 60 belgi |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "def_1",
      "vehicleId": "veh_1",
      "severity": "CRITICAL",
      "status": "OPEN",
      "outOfService": true
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/defects/{id}`

**Nima qiladi:** Bitta defekt.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `DefectsController_get` · original: _Gets one defect._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "def_1",
  "vehicleId": "veh_1",
  "severity": "CRITICAL",
  "status": "OPEN"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEFECT_NOT_FOUND — Defect not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/defects/{id}/resolve`

**Nima qiladi:** Defektni yopadi (REPAIRED/NOT_REQUIRED/DEFERRED + ta'mir ma'lumotlari). Oxirgi ochiq defekt bo'lsa unit OUT_OF_SERVICE'dan chiqadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `DefectsController_resolve` · original: _Resolves a defect (resolutionType REPAIRED/NOT_REQUIRED/DEFERRED, plus B-70 repair-record fields). Restores the unit from OUT_OF_SERVICE if it was the last open CRITICAL defect. NOT_REQUIRED is never recorded as a repair._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `resolutionType` | `REPAIRED` \| `NOT_REQUIRED` \| `DEFERRED` | ha |  |  |
| `resolutionNote` | string | yo'q | ≤ 500 belgi |  |
| `correctedBy` | string | yo'q | ≤ 120 belgi |  |
| `completedAt` | string (date-time) | yo'q |  |  |
| `laborHours` | number | yo'q | 0–999 |  |
| `partsCostUsd` | number | yo'q | 0–1000000 |  |

**Javob `200`:** 

```json
{
  "id": "def_1",
  "status": "REPAIRED",
  "resolutionType": "REPAIRED",
  "resolvedAt": "2026-09-11T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEFECT_NOT_FOUND — Defect not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/defects/{id}/assign`

**Nima qiladi:** Defekt mas'ulini/ustaxonani belgilaydi yoki tozalaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `DefectsController_assign` · original: _Sets (or clears, with `assigneeId: null`) the defect assignee/shop (B-40, W-09 ASSIGNED TO)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `assigneeId` | string (uuid) | ha, null mumkin |  |  |

**Javob `200`:** 

```json
{
  "id": "def_1",
  "assigneeId": "usr_2"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEFECT_NOT_FOUND — Defect not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/defects/{id}/work-order`

**Nima qiladi:** Defektni work order'ga biriktiradi yoki ajratadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `DefectsController_linkWorkOrder` · original: _Attaches (or detaches, with `workOrderId: null`) a defect to a work order._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `workOrderId` | string (uuid) | ha, null mumkin |  |  |

**Javob `200`:** 

```json
{
  "id": "def_1",
  "workOrderId": "wo_1"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEFECT_NOT_FOUND — Defect not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-work-orders"></a>

## Work order'lar

### `GET /api/work-orders`

**Nima qiladi:** Work order'lar ro'yxati.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/create-work-order', 'title': 'Create work order', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.18'}`
- **operationId:** `WorkOrdersController_list` · original: _Lists work orders._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `priority` | query | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT` | yo'q |  |  |
| `status` | query | `OPEN` \| `IN_PROGRESS` \| `DONE` \| `CANCELLED` | yo'q |  |  |
| `vehicleId` | query | string (uuid) | yo'q |  |  |
| `q` | query | string | yo'q | ≤ 200 belgi |  |
| `sort` | query | string | yo'q | ≤ 60 belgi |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "wo_1",
      "number": "WO-0001",
      "vehicleId": "veh_1",
      "status": "OPEN",
      "priority": "NORMAL"
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/work-orders`

**Nima qiladi:** Work order yaratadi, ixtiyoriy ochiq defektlarni biriktiradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/create-work-order', 'title': 'Create work order', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.18'}`
- **operationId:** `WorkOrdersController_create` · original: _Creates a work order (TZ §5.10 "Create work order" screen), optionally attaching open defects._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `vehicleId` | string (uuid) | ha |  |  |
| `title` | string | ha | 1–200 belgi |  |
| `description` | string | yo'q | ≤ 2000 belgi |  |
| `priority` | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT` | yo'q |  |  |
| `vendor` | string | yo'q | ≤ 120 belgi |  |
| `costUsd` | number | yo'q | 0–1000000 |  |
| `odometerMi` | integer | yo'q | ≥ 0 |  |
| `dueAt` | string (date-time) | yo'q |  |  |
| `defectIds` | string (uuid)[] | yo'q | ≤ 50 ta |  |
| `estimatedLaborHours` | number | yo'q | 0–999 |  |
| `keepOutOfService` | boolean | yo'q | default `false` |  |
| `notifyDriver` | boolean | yo'q | default `true` |  |
| `blockDispatchAssignment` | boolean | yo'q | default `false` |  |

**Javob `201`:** 

```json
{
  "id": "wo_9",
  "number": "WO-0009",
  "vehicleId": "veh_1",
  "status": "OPEN",
  "priority": "NORMAL"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/work-orders/{id}`

**Nima qiladi:** Bitta work order.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/create-work-order', 'title': 'Create work order', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.18'}`
- **operationId:** `WorkOrdersController_get` · original: _Gets one work order._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "wo_1",
  "number": "WO-0001",
  "vehicleId": "veh_1",
  "status": "OPEN"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` WORK_ORDER_NOT_FOUND — Work order not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/work-orders/{id}`

**Nima qiladi:** Work order'ni tahrirlaydi (sarlavha, prioritet, vendor, narx, muddat). DONE/CANCELLED bo'lgach bloklanadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/create-work-order', 'title': 'Create work order', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.18'}`
- **operationId:** `WorkOrdersController_update` · original: _Edits a work order (title, priority, vendor, cost, due date). Blocked once DONE/CANCELLED._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `title` | string | yo'q | 1–200 belgi |  |
| `description` | string | yo'q | ≤ 2000 belgi |  |
| `priority` | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT` | yo'q |  |  |
| `status` | `OPEN` \| `IN_PROGRESS` | yo'q |  |  |
| `vendor` | string | yo'q | ≤ 120 belgi |  |
| `costUsd` | number | yo'q | 0–1000000 |  |
| `odometerMi` | integer | yo'q | ≥ 0 |  |
| `dueAt` | string (date-time) | yo'q, null mumkin |  |  |
| `estimatedLaborHours` | number | yo'q | 0–999 |  |
| `keepOutOfService` | boolean | yo'q |  |  |
| `notifyDriver` | boolean | yo'q |  |  |
| `blockDispatchAssignment` | boolean | yo'q |  |  |

**Javob `200`:** 

```json
{
  "id": "wo_1",
  "status": "IN_PROGRESS",
  "costUsd": "420.00"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` WORK_ORDER_NOT_FOUND — Work order not found. · `409` WORK_ORDER_CLOSED — Work order is already closed or cancelled. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/work-orders/{id}/close`

**Nima qiladi:** Work order'ni yopadi (DONE). Barcha biriktirilgan defektlar yopilgan bo'lishi shart.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/create-work-order', 'title': 'Create work order', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.18'}`
- **operationId:** `WorkOrdersController_close` · original: _Closes a work order (status -> DONE). Requires every attached defect to already be resolved._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `201`:** 

```json
{
  "id": "wo_1",
  "status": "DONE",
  "closedAt": "2026-09-11T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` WORK_ORDER_NOT_FOUND — Work order not found. · `409` DEFECT_NOT_RESOLVED — One or more attached defects are not resolved yet. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/work-orders/{id}/cancel`

**Nima qiladi:** Work order'ni bekor qiladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/create-work-order', 'title': 'Create work order', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.18'}`
- **operationId:** `WorkOrdersController_cancel` · original: _Cancels a work order._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `201`:** 

```json
{
  "id": "wo_1",
  "status": "CANCELLED"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` WORK_ORDER_NOT_FOUND — Work order not found. · `409` WORK_ORDER_CLOSED — Work order is already closed or cancelled. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/work-orders/{id}/defects/{defectId}`

**Nima qiladi:** Ochiq defektni shu work order'ga biriktiradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/create-work-order', 'title': 'Create work order', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.18'}`
- **operationId:** `WorkOrdersController_attachDefect` · original: _Attaches an open defect to this work order._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |
| `defectId` | path | string | ha |  |  |

**Javob `201`:** 

```json
{
  "id": "wo_1",
  "status": "OPEN"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` DEFECT_NOT_FOUND — Defect not found. · `409` WORK_ORDER_CLOSED — Work order is already closed or cancelled. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-maintenance"></a>

## Texnik xizmat

### `GET /api/maintenance-schedules`

**Nima qiladi:** Texnik xizmat jadvallari, hisoblangan muddat holati bilan.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `MaintenanceSchedulesController_list` · original: _Lists maintenance schedules with computed due state._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `dueOnly` | query | boolean | yo'q |  | Only schedules currently DUE_SOON or OVERDUE. |
| `status` | query | `OPEN` \| `COMPLETED` \| `CANCELLED` \| `REJECTED` | yo'q |  | M-40 — e.g. OPEN to find driver submissions awaiting review (submittedAt set). |
| `enabled` | query | boolean | yo'q |  |  |
| `vehicleId` | query | string (uuid) | yo'q |  |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "ms_1",
      "vehicleId": "veh_1",
      "name": "Brake service",
      "intervalMi": 25000,
      "due": {
        "state": "DUE_SOON",
        "nextDueMi": 995000,
        "milesRemaining": 300
      }
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/maintenance-schedules`

**Nima qiladi:** Texnik xizmat jadvali yaratadi ("Brake service", "DOT annual inspection" va h.k.).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `MaintenanceSchedulesController_create` · original: _Creates a maintenance schedule ("Brake service", "DOT annual inspection", ...)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `vehicleId` | string (uuid) | ha |  |  |
| `name` | string | ha | 1–120 belgi |  |
| `scheduleType` | string | yo'q | 1–40 belgi |  |
| `intervalMi` | integer | yo'q | 1–2000000 |  |
| `intervalDays` | integer | yo'q | 1–3660 |  |
| `lastServiceMi` | integer | yo'q | ≥ 0 |  |
| `lastServiceAt` | string (date-time) | yo'q |  |  |
| `enabled` | boolean | yo'q | default `true` |  |

**Javob `201`:** 

```json
{
  "id": "ms_9",
  "vehicleId": "veh_1",
  "name": "DOT annual inspection",
  "intervalDays": 365
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_NOT_FOUND — Vehicle not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/maintenance-schedules/{id}`

**Nima qiladi:** Bitta jadval, muddat holati bilan.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `MaintenanceSchedulesController_get` · original: _Gets one maintenance schedule with computed due state._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "ms_1",
  "vehicleId": "veh_1",
  "name": "Brake service",
  "due": {
    "state": "OK"
  }
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` MAINTENANCE_SCHEDULE_NOT_FOUND — Maintenance schedule not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/maintenance-schedules/{id}`

**Nima qiladi:** Jadvalni tahrirlaydi; `status` + `reviewNote` bilan haydovchi invoice'ini tasdiqlaydi (COMPLETED) yoki rad etadi (REJECTED).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `MaintenanceSchedulesController_update` · original: _Edits a maintenance schedule; `status` + `reviewNote` approve (COMPLETED) / reject (REJECTED) a driver invoice submission._
- **Izoh (backend):** M-40 — COMPLETED resets the interval clock like `/complete`; REJECTED requires `reviewNote` (shown to the driver). The submitted invoice is read via `invoiceAttachmentId` -> `GET /attachments/:id/presign`.

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `name` | string | yo'q | 1–120 belgi |  |
| `scheduleType` | string | yo'q | 1–40 belgi |  |
| `status` | `OPEN` \| `COMPLETED` \| `CANCELLED` \| `REJECTED` | yo'q |  |  |
| `reviewNote` | string | yo'q, null mumkin | ≤ 500 belgi |  |
| `intervalMi` | integer | yo'q, null mumkin | 1–2000000 |  |
| `intervalDays` | integer | yo'q, null mumkin | 1–3660 |  |
| `lastServiceMi` | integer | yo'q | ≥ 0 |  |
| `lastServiceAt` | string (date-time) | yo'q |  |  |
| `enabled` | boolean | yo'q |  |  |

**Javob `200`:** 

```json
{
  "id": "ms_1",
  "enabled": false,
  "status": "REJECTED",
  "reviewNote": "Amount does not match the PDF."
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` MAINTENANCE_SCHEDULE_NOT_FOUND — Maintenance schedule not found. · `422` VALIDATION_FAILED — status REJECTED without a reviewNote.

---

### `DELETE /api/maintenance-schedules/{id}`

**Nima qiladi:** Texnik xizmat jadvalini o'chiradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `MaintenanceSchedulesController_remove` · original: _Deletes a maintenance schedule._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "deleted": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` MAINTENANCE_SCHEDULE_NOT_FOUND — Maintenance schedule not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/maintenance-schedules/{id}/complete`

**Nima qiladi:** Jadvalni hozir bajarilgan deb belgilaydi, interval qaytadan boshlanadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dvir-maintenance', 'title': 'DVIR & Maintenance', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.17'}`
- **operationId:** `MaintenanceSchedulesController_complete` · original: _Marks a schedule serviced now, resetting the interval clock._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `serviceOdometerMi` | integer | yo'q | ≥ 0 |  |
| `serviceAt` | string (date-time) | yo'q |  |  |

**Javob `201`:** 

```json
{
  "id": "ms_1",
  "lastServiceMi": 994700,
  "nextDueMi": 1019700
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` MAINTENANCE_SCHEDULE_NOT_FOUND — Maintenance schedule not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-support"></a>

## Support

### `GET /api/support/tickets`

**Nima qiladi:** Support tiketlari ro'yxati.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-support', 'title': 'Settings · Support', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `SupportController_list` · original: _Lists support tickets._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `priority` | query | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT` | yo'q |  |  |
| `status` | query | `OPEN` \| `IN_PROGRESS` \| `RESOLVED` \| `CLOSED` | yo'q |  |  |
| `q` | query | string | yo'q | ≤ 200 belgi |  |
| `sort` | query | string | yo'q | ≤ 60 belgi |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "tck_1",
      "number": "TCK-000001",
      "subject": "Device offline",
      "status": "OPEN"
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/support/tickets`

**Nima qiladi:** Support tiketi ochadi (support:READ yetarli).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-support', 'title': 'Settings · Support', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `SupportController_create` · original: _Opens a support ticket. B-12: allowed at support:READ (e.g. VIEWER) — submitting a ticket isn't a config change._

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

**Javob `201`:** 

```json
{
  "id": "tck_9",
  "number": "TCK-000009",
  "subject": "eRODS transfer rejected",
  "status": "OPEN",
  "priority": "NORMAL"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/support/tickets/{id}`

**Nima qiladi:** Bitta support tiketi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-support', 'title': 'Settings · Support', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `SupportController_get` · original: _Gets one support ticket._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "tck_1",
  "number": "TCK-000001",
  "subject": "Device offline",
  "body": "Unit #110 has not reported since Sep 09.",
  "status": "OPEN",
  "priority": "HIGH",
  "requesterType": "USER",
  "requesterId": "usr_1",
  "createdAt": "2026-09-11T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Support ticket not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/support/tickets/{id}`

**Nima qiladi:** Tiketni yangilaydi (holat, prioritet, mas'ul).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-support', 'title': 'Settings · Support', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `SupportController_update` · original: _Updates a support ticket (status, priority, assignee)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `status` | `OPEN` \| `IN_PROGRESS` \| `RESOLVED` \| `CLOSED` | yo'q |  |  |
| `assignedToId` | string (uuid) | yo'q |  |  |
| `priority` | `LOW` \| `NORMAL` \| `HIGH` \| `URGENT` | yo'q |  |  |

**Javob `200`:** 

```json
{
  "id": "tck_1",
  "number": "TCK-000001",
  "status": "RESOLVED",
  "priority": "HIGH",
  "assigneeId": "usr_2"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Support ticket not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/support/chats`

**Nima qiladi:** Real-time support chat ochadi va birinchi xabarni yuboradi; javoblar `conversation:{id}` socket room'ida.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-support', 'title': 'Settings · Support', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `SupportController_createChat` · original: _B-90 — opens a real-time support chat (Conversation type SUPPORT) and sends the first message; subscribe the `conversation:{id}` socket room for replies._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `subject` | string | yo'q | ≤ 200 belgi |  |
| `message` | string | ha | 1–2000 belgi |  |

**Javob `201`:** 

```json
{
  "conversationId": "cnv_9",
  "messageId": "msg_1"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/feedback`

**Nima qiladi:** In-app fikr-mulohaza yuboradi (support:READ yetarli).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/settings-support', 'title': 'Settings · Support', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)'}`
- **operationId:** `SupportController_createFeedback` · original: _Submits in-app feedback (mobile + web). B-12: allowed at support:READ._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `answers` | object | ha |  |  |
| `answers.tenure` | string yoki number | yo'q |  |  |
| `answers.ease` | string yoki number | yo'q |  |  |
| `answers.hosSatisfaction` | string yoki number | yo'q |  |  |
| `answers.recommend` | string yoki number | yo'q |  |  |
| `answers.overallExperience` | integer | yo'q | 1–5 |  |
| `clientId` | string (uuid) | yo'q |  |  |
| `comment` | string | yo'q | ≤ 1000 belgi |  |
| `appVersion` | string | yo'q | ≤ 40 belgi |  |
| `platform` | string | yo'q | ≤ 40 belgi |  |

**Javob `201`:** 

```json
{
  "id": "fbk_1",
  "rating": 5,
  "message": "The 8-day recap view is exactly what we needed.",
  "source": "WEB",
  "createdAt": "2026-09-11T15:41:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-trips"></a>

## Trip / dispatch

### `GET /api/trips`

**Nima qiladi:** Trip/yuklar ro'yxati, dispatch holati bilan.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dispatch-trips', 'title': 'Dispatch & Trips', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)'}`
- **operationId:** `TripsController_list` · original: _Lists trips/loads with dispatch status._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `status` | query | `DRAFT` \| `PLANNED` \| `ASSIGNED` \| `IN_PROGRESS` \| `DELIVERED` \| `CANCELLED` | yo'q |  |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |
| `sort` | query | string | yo'q | ≤ 60 belgi |  |
| `q` | query | string | yo'q | ≤ 200 belgi |  |
| `driverId` | query | string (uuid) | yo'q |  |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "trp_1",
      "number": "TRP-1001",
      "status": "PLANNED"
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/trips`

**Nima qiladi:** Trip/yuk yaratadi, ixtiyoriy stoplar va boshlang'ich haydovchi/unit bilan.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dispatch-trips', 'title': 'Dispatch & Trips', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)'}`
- **operationId:** `TripsController_create` · original: _Creates a trip/load, optionally with stops and an initial driver/vehicle._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `number` | string | ha | 1–40 belgi |  |
| `driverId` | string (uuid) | yo'q |  |  |
| `vehicleId` | string (uuid) | yo'q |  |  |
| `trailerId` | string (uuid) | yo'q |  |  |
| `shippingDocument` | string | yo'q | ≤ 60 belgi |  |
| `commodity` | string | yo'q | ≤ 120 belgi |  |
| `weightLbs` | integer | yo'q | ≥ 0 |  |
| `pieces` | integer | yo'q | ≥ 0 |  |
| `plannedStartAt` | string (date-time) | yo'q |  |  |
| `plannedEndAt` | string (date-time) | yo'q |  |  |
| `notes` | string | yo'q | ≤ 500 belgi |  |
| `stops` | object[] | yo'q | ≤ 50 ta |  |
| `stops[].sequence` | integer | ha | ≥ 1 |  |
| `stops[].type` | `PICKUP` \| `DELIVERY` \| `FUEL` \| `REST` \| `CHECKPOINT` | ha |  |  |
| `stops[].name` | string | ha | 1–200 belgi |  |
| `stops[].address` | string | yo'q | ≤ 300 belgi |  |
| `stops[].latitude` | number | yo'q | -90–90 |  |
| `stops[].longitude` | number | yo'q | -180–180 |  |
| `stops[].scheduledAt` | string (date-time) | yo'q |  |  |
| `stops[].note` | string | yo'q | ≤ 500 belgi |  |
| `distanceMi` | number | yo'q | >True–10000 |  |
| `rateUsd` | number | yo'q | >True–1000000 |  |
| `customer` | string | yo'q | ≤ 200 belgi |  |
| `estimatedDriveSec` | integer | yo'q | ≥ >True |  |
| `draft` | boolean | yo'q | default `false` |  |

**Javob `201`:** 

```json
{
  "id": "trp_3",
  "number": "TRP-1003",
  "status": "PLANNED"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `409` Field-level conflict — one of: CONFLICT (details.number: "A trip with this number already exists."); TRIP_SCHEDULE_CONFLICT (details.vehi… · `422` TRAILER_NOT_FOUND — trailerId is unknown or names a deleted trailer.

---

### `GET /api/trips/unassigned-loads`

**Nima qiladi:** Hali haydovchi biriktirilmagan yuklar (dispatch "unassigned" ustuni).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dispatch-trips', 'title': 'Dispatch & Trips', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)'}`
- **operationId:** `TripsController_unassigned` · original: _Loads with no driver assigned yet (dispatch board "unassigned" column)._

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "trp_2",
      "number": "TRP-1002",
      "status": "PLANNED"
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/trips/{id}`

**Nima qiladi:** Bitta trip, stoplari bilan.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dispatch-trips', 'title': 'Dispatch & Trips', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)'}`
- **operationId:** `TripsController_get` · original: _One trip with its stops._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "trp_1",
  "number": "TRP-1001",
  "status": "ASSIGNED",
  "stops": []
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Trip not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/trips/{id}`

**Nima qiladi:** Trip maydonlarini yangilaydi yoki holatini oldinga suradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dispatch-trips', 'title': 'Dispatch & Trips', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)'}`
- **operationId:** `TripsController_update` · original: _Updates trip fields or advances its lifecycle status._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `status` | `DRAFT` \| `PLANNED` \| `ASSIGNED` \| `IN_PROGRESS` \| `DELIVERED` \| `CANCELLED` | yo'q |  |  |
| `shippingDocument` | string | yo'q | ≤ 60 belgi |  |
| `commodity` | string | yo'q | ≤ 120 belgi |  |
| `weightLbs` | integer | yo'q | ≥ 0 |  |
| `pieces` | integer | yo'q | ≥ 0 |  |
| `plannedStartAt` | string (date-time) | yo'q |  |  |
| `plannedEndAt` | string (date-time) | yo'q |  |  |
| `etaAt` | string (date-time) | yo'q |  |  |
| `notes` | string | yo'q | ≤ 500 belgi |  |
| `distanceMi` | number | yo'q | >True–10000 |  |
| `rateUsd` | number | yo'q | >True–1000000 |  |
| `customer` | string | yo'q | ≤ 200 belgi |  |
| `estimatedDriveSec` | integer | yo'q | ≥ >True |  |

**Javob `200`:** 

```json
{
  "id": "trp_1",
  "status": "IN_PROGRESS"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Trip not found. · `409` Field-level conflict — one of: CONFLICT (details.status: "Illegal status transition."); TRIP_SCHEDULE_CONFLICT (details.vehicleId: "The t… · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/trips/{id}`

**Nima qiladi:** Tripni stoplari bilan butunlay o'chiradi (IN_PROGRESS o'chirilmaydi).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dispatch-trips', 'title': 'Dispatch & Trips', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)'}`
- **operationId:** `TripsController_remove` · original: _Hard-deletes a trip and its stops (the trip number becomes reusable). IN_PROGRESS trips cannot be deleted._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `204`:** Deleted.

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Trip not found. · `409` TRIP_IN_PROGRESS — This trip is in progress and cannot be deleted. Finish or cancel it first. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/trips/{id}/assign`

**Nima qiladi:** Tripga haydovchi/unit/treyler biriktiradi yoki almashtiradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dispatch-trips', 'title': 'Dispatch & Trips', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)'}`
- **operationId:** `TripsController_assign` · original: _Assigns (or reassigns) a driver/vehicle/trailer to a trip._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `driverId` | string (uuid) | ha |  |  |
| `vehicleId` | string (uuid) | yo'q |  |  |
| `trailerId` | string (uuid) | yo'q |  |  |
| `notify` | boolean | yo'q | default `true` |  |

**Javob `200`:** 

```json
{
  "id": "trp_2",
  "status": "ASSIGNED",
  "driverId": "drv_1"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Trip not found. · `409` Field-level conflict — one of: CONFLICT (details.status: "Only a planned or assigned trip can be (re)assigned."); TRIP_SCHEDULE_CONFLICT … · `422` TRAILER_NOT_FOUND — trailerId is unknown or names a deleted trailer.

---

### `POST /api/trips/auto-assign`

**Nima qiladi:** Biriktirilmagan har bir yukni navbatdagi bo'sh ACTIVE haydovchiga beradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/dispatch-trips', 'title': 'Dispatch & Trips', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)'}`
- **operationId:** `TripsController_autoAssign` · original: _Greedily assigns every unassigned load to the next free ACTIVE driver._

**Javob `200`:** 

```json
{
  "assigned": [
    {
      "tripId": "trp_2",
      "driverId": "drv_1"
    }
  ],
  "skipped": 0
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-safety"></a>

## Safety

### `GET /api/safety/events` ♻️ O'ZGARGAN

**Nima qiladi:** Harsh-driving hodisalari ro'yxati. 🆕 qurilma akselerometri (EV_MEMS_*) dan kelgan HARSH_ACCEL/HARSH_BRAKING/HARSH_TURN ham shu yerda.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/safety', 'title': 'Safety', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.19'}`
- **operationId:** `SafetyController_listEvents` · original: _Lists harsh-driving events ("Events by type")._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `limit` | query | integer | yo'q | 1–200, default `25` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |
| `sort` | query | string | yo'q | ≤ 60 belgi |  |
| `q` | query | string | yo'q | ≤ 200 belgi |  |
| `driverId` | query | string (uuid) | yo'q |  |  |
| `vehicleId` | query | string (uuid) | yo'q |  |  |
| `type` | query | `HARSH_BRAKING` \| `HARSH_ACCEL` \| `HARSH_TURN` \| `SPEEDING` \| `SEATBELT` | yo'q |  |  |
| `status` | query | `NEW` \| `REVIEWED` \| `COACHED` \| `DISMISSED` | yo'q |  |  |
| `from` | query | string (date-time) | yo'q |  |  |
| `to` | query | string (date-time) | yo'q |  |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "sfe_1",
      "type": "HARSH_BRAKING",
      "severity": 3,
      "status": "NEW"
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/safety/events/{id}`

**Nima qiladi:** Safety hodisasini REVIEWED/DISMISSED qiladi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/safety', 'title': 'Safety', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.19'}`
- **operationId:** `SafetyController_updateEvent` · original: _Marks a safety event REVIEWED/DISMISSED (short of full coaching)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `status` | `NEW` \| `REVIEWED` \| `COACHED` \| `DISMISSED` | ha |  |  |
| `coachingNote` | string | yo'q | ≤ 1000 belgi |  |

**Javob `200`:** 

```json
{
  "id": "sfe_1",
  "status": "REVIEWED"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Safety event not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/safety/scorecard`

**Nima qiladi:** Flot safety bahosi va haydovchilar reytingi (70 dan pasti belgilanadi), oldingi davr bilan trend.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/safety', 'title': 'Safety', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.19'}`
- **operationId:** `SafetyController_scorecard` · original: _Fleet safety score and per-driver ranking ("Driver scorecard", below-70 flagged). B-44: each row includes previousScore/trend vs. the prior period of the same length._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `periodStart` | query | string (date-time) | yo'q |  |  |
| `periodEnd` | query | string (date-time) | yo'q |  |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "driverId": "drv_1",
      "score": 68,
      "harshCount": 4,
      "rank": 1,
      "previousScore": 74,
      "trend": -6
    }
  ],
  "periodStart": "2026-08-12",
  "periodEnd": "2026-09-11"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/safety/coaching`

**Nima qiladi:** "Assign coaching": hodisani izoh bilan COACHED qilib yopadi, yoki `driverId` bilan haydovchi darajasida.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/safety', 'title': 'Safety', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.19'}`
- **operationId:** `SafetyController_coach` · original: _"Assign coaching" — closes a safety event as COACHED with a note. B-43: pass `driverId` instead of `eventId` to assign at the driver level (coaches that driver's most recent open event)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `eventId` | string (uuid) | yo'q |  |  |
| `driverId` | string (uuid) | yo'q |  |  |
| `note` | string | yo'q | ≤ 1000 belgi |  |

**Javob `200`:** 

```json
{
  "id": "sfe_1",
  "status": "COACHED",
  "coachedById": "usr_1"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Safety event not found (or no open event for the given driverId). · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-geofences"></a>

## Geofence'lar

### `GET /api/geofences`

**Nima qiladi:** Live Fleet xaritasidagi barcha geofence'lar.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/live-fleet', 'title': 'Live Fleet', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.7'}`
- **operationId:** `GeofencesController_list` · original: _Lists all geofences drawn on the Live Fleet map._

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "gf_1",
      "name": "Columbus Terminal",
      "type": "CIRCLE",
      "radiusMi": 1,
      "alertOnEnter": true,
      "colour": "BLUE",
      "countAsYardMove": false,
      "vehicleGroupId": null,
      "vehicleGroupName": null
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/geofences`

**Nima qiladi:** Yangi terminal/mijoz geofence'ini chizadi (doira yoki poligon); ixtiyoriy `vehicleGroupId`.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/live-fleet', 'title': 'Live Fleet', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.7'}`
- **operationId:** `GeofencesController_create` · original: _Draws a new terminal/customer geofence (circle or polygon)._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `name` | string | ha | 1–120 belgi |  |
| `type` | `CIRCLE` \| `POLYGON` \| `ADDRESS` | yo'q |  |  |
| `centerLat` | number | yo'q | -90–90 |  |
| `centerLon` | number | yo'q | -180–180 |  |
| `radiusMi` | number | yo'q | >True–500 |  |
| `radiusMeters` | number | yo'q | >True–500 |  |
| `polygon` | object[] | yo'q | ≥ 3 ta |  |
| `polygon[].lat` | number | ha |  |  |
| `polygon[].lon` | number | ha |  |  |
| `address` | string | yo'q | 1–300 belgi |  |
| `category` | string | yo'q | ≤ 60 belgi |  |
| `alertOnEnter` | boolean | yo'q | default `false` |  |
| `alertOnExit` | boolean | yo'q | default `false` |  |
| `dwellMinutes` | integer | yo'q | >True–1440 |  |
| `afterHoursOnly` | boolean | yo'q | default `false` |  |
| `colour` | `BLUE` \| `GREEN` \| `AMBER` \| `RED` \| `VIOLET` | yo'q |  |  |
| `countAsYardMove` | boolean | yo'q | default `false` |  |
| `vehicleGroupId` | string (uuid) | yo'q, null mumkin |  |  |

**Javob `201`:** 

```json
{
  "id": "gf_2",
  "name": "Cust. dock 4",
  "type": "CIRCLE",
  "radiusMi": 0.5,
  "colour": "GREEN",
  "countAsYardMove": true,
  "vehicleGroupId": "b1c2d3e4-0000-4000-8000-000000000001"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_GROUP_NOT_FOUND — Vehicle group not found. · `422` VALIDATION_FAILED — CIRCLE requires centerLat/centerLon/radiusMi; POLYGON requires polygon points.

---

### `GET /api/geofences/{id}`

**Nima qiladi:** Bitta geofence.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/live-fleet', 'title': 'Live Fleet', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.7'}`
- **operationId:** `GeofencesController_get` · original: _One geofence._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "gf_1",
  "name": "Columbus Terminal",
  "type": "CIRCLE",
  "colour": "BLUE",
  "countAsYardMove": false,
  "vehicleGroupId": "b1c2d3e4-0000-4000-8000-000000000001",
  "vehicleGroupName": "Northeast"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Geofence not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `PATCH /api/geofences/{id}`

**Nima qiladi:** Geofence'ni yangilaydi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/live-fleet', 'title': 'Live Fleet', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.7'}`
- **operationId:** `GeofencesController_update` · original: _Updates a geofence._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `name` | string | yo'q | 1–120 belgi |  |
| `centerLat` | number | yo'q | -90–90 |  |
| `centerLon` | number | yo'q | -180–180 |  |
| `radiusMi` | number | yo'q | >True–500 |  |
| `radiusMeters` | number | yo'q | >True–500 |  |
| `polygon` | object[] | yo'q | ≥ 3 ta |  |
| `polygon[].lat` | number | ha |  |  |
| `polygon[].lon` | number | ha |  |  |
| `address` | string | yo'q | 1–300 belgi |  |
| `category` | string | yo'q | ≤ 60 belgi |  |
| `alertOnEnter` | boolean | yo'q |  |  |
| `alertOnExit` | boolean | yo'q |  |  |
| `dwellMinutes` | integer | yo'q, null mumkin | >True–1440 |  |
| `afterHoursOnly` | boolean | yo'q |  |  |
| `colour` | `BLUE` \| `GREEN` \| `AMBER` \| `RED` \| `VIOLET` | yo'q |  |  |
| `countAsYardMove` | boolean | yo'q |  |  |
| `enabled` | boolean | yo'q |  |  |
| `vehicleGroupId` | string (uuid) | yo'q, null mumkin |  |  |

**Javob `200`:** 

```json
{
  "id": "gf_1",
  "enabled": false,
  "vehicleGroupId": null
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Geofence not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/geofences/{id}`

**Nima qiladi:** Geofence'ni o'chiradi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/live-fleet', 'title': 'Live Fleet', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.7'}`
- **operationId:** `GeofencesController_remove` · original: _Removes a geofence._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "gf_1",
  "deleted": true
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` NOT_FOUND — Geofence not found. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-search"></a>

## Qidiruv

### `GET /api/search`

**Nima qiladi:** Command palette uchun global haydovchi + unit qidiruvi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/fleet-dashboard', 'title': 'Fleet Dashboard', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5'}`
- **operationId:** `SearchController_search` · original: _Global driver + vehicle search for the command palette._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `limit` | query | integer | yo'q | 1–25, default `5` |  |
| `q` | query | string | ha | 1–200 belgi |  |

**Javob `200`:** 

```json
{
  "q": "smith",
  "drivers": [
    {
      "id": "drv_1",
      "name": "John Smith"
    }
  ],
  "vehicles": []
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-live"></a>

## Live fleet

### `GET /api/live/fleet` ♻️ O'ZGARGAN

**Nima qiladi:** Har bir unitning joriy holati: oxirgi pozitsiya, tezlik, haydovchi, duty status, HOS soatlari, ELD aloqasi. 🆕 pin koordinatasi bor oxirgi nuqtadan olinadi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/live-fleet', 'title': 'Live Fleet', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.7'}`, `{'id': 'web/fleet-dashboard', 'title': 'Fleet Dashboard', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5'}`
- **operationId:** `LiveFleetController_fleet` · original: _Current snapshot of every unit: last known position, speed, driver, duty status, HOS clocks, ELD link._

**Javob `200`:** 

```json
{
  "items": [
    {
      "vehicleId": "veh_1",
      "unitNumber": "101",
      "driverId": "drv_1",
      "driverName": "John Smith",
      "driverPhone": "+1 334 765 4888",
      "dutyStatus": "ON_DUTY",
      "speedMph": 0,
      "headingDeg": 274,
      "odometerMi": 993589,
      "lat": 38.99,
      "lon": -84.63,
      "locationLabel": "0.64 mi N of Florence, KY",
      "lastSeenAt": "2026-09-12T15:39:00.000Z",
      "driveRemainingSec": 0,
      "shiftEndsAt": "2026-09-12T15:59:34.000Z",
      "eldSerial": "PT30_A86E",
      "bleState": "CONNECTED"
    }
  ],
  "generatedAt": "2026-09-12T15:39:10.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-dashboard"></a>

## Dashboard

### `GET /api/dashboard/summary`

**Nima qiladi:** W-01 Fleet Dashboard uchun bitta so'rovda: live fleet, 24 soatlik violation'lar, kutilayotgan unidentified, o'qilmagan bildirishnomalar, carrier va unit statistikasi.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/fleet-dashboard', 'title': 'Fleet Dashboard', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.5'}`
- **operationId:** `DashboardController_summary` · original: _One-call aggregate for the W-01 Fleet Dashboard: live fleet, 24h violations, pending unidentified driving, unread notification count, carrier basics, and vehicle counts._

**Javob `200`:** 

```json
{
  "liveFleet": {
    "items": [
      {
        "vehicleId": "veh_1",
        "unitNumber": "101",
        "dutyStatus": "DRIVING"
      }
    ],
    "generatedAt": "2026-09-16T15:39:10.000Z",
    "counts": {
      "total": 42,
      "onDuty": 30,
      "moving": 18,
      "idle": 5,
      "offline": 2
    }
  },
  "violations": {
    "items": [
      {
        "id": "vio_1",
        "type": "DRIVING_11",
        "driverName": "John Smith",
        "unitNumber": "101"
      }
    ],
    "total": 3
  },
  "unidentified": {
    "total": 2,
    "totalDurationSec": 3600
  },
  "notifications": {
    "unreadCount": 4
  },
  "carrier": {
    "id": "carrier",
    "name": "Universal Logistics Inc.",
    "timezone": "America/New_York"
  },
  "vehicles": {
    "active": 40,
    "total": 45
  },
  …
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

<a id="bolim-reports"></a>

## Hisobotlar

### `POST /api/reports/generate`

**Nima qiladi:** Hisobot ishini navbatga qo'yadi. Sinxron emas — GET /reports/:id bilan so'rang yoki `report.ready` ni tinglang.

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `ReportsController_generate` · original: _Queues a report job. Never generates synchronously — poll GET /reports/:id or listen for report.ready._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `type` | `IFTA` \| `ACTIVITY` \| `DVIR` \| `FMCSA_PACK` \| `RODS` \| `IDLE_FUEL` | ha |  |  |
| `format` | `CSV` \| `PDF` \| `XLSX` | yo'q | default `"CSV"` |  |
| `params` | object | yo'q | default `{}` |  |

**Javob `202`:** Queued.

```json
{
  "reportId": "rpt_1",
  "status": "QUEUED"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — reports = FULL is required to generate a report (§6.4). · `422` VALIDATION_FAILED — Requested format is not supported for this report type.

---

### `GET /api/reports`

**Nima qiladi:** Hisobot ishlari ro'yxati, eng yangisi birinchi.

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `ReportsController_list` · original: _Lists report jobs (own carrier), newest first._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `type` | query | `IFTA` \| `ACTIVITY` \| `DVIR` \| `FMCSA_PACK` \| `RODS` \| `IDLE_FUEL` | yo'q |  |  |
| `status` | query | `QUEUED` \| `RUNNING` \| `READY` \| `FAILED` | yo'q |  |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "rpt_1",
      "type": "IFTA",
      "status": "READY",
      "requestedAt": "2026-09-11T06:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/reports/schedules`

**Nima qiladi:** Hisobot jadvallari (cron).

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `ReportsController_listSchedules` · original: _Lists report schedules (TZ §15 report scheduler — cron definitions persisted in the DB)._

**Javob `200`:** 

```json
{
  "items": [
    {
      "id": "sch_1",
      "reportType": "ACTIVITY",
      "cron": "0 6 * * 1",
      "enabled": true,
      "nextRunAt": "2026-09-14T06:00:00.000Z"
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `POST /api/reports/schedules`

**Nima qiladi:** Hisobot jadvali yaratadi; `nextRunAt` cron/timezone'dan hisoblanadi.

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `ReportsController_createSchedule` · original: _Creates a report schedule. `nextRunAt` is computed from `cron`/`timezone` and the scheduler picks it up without a manual trigger._

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `reportType` | `IFTA` \| `ACTIVITY` \| `DVIR` \| `FMCSA_PACK` \| `RODS` \| `IDLE_FUEL` | ha |  |  |
| `format` | `CSV` \| `PDF` \| `XLSX` | yo'q | default `"CSV"` |  |
| `params` | object | yo'q | default `{}` |  |
| `cron` | string | ha | ≥ 1 belgi |  |
| `timezone` | string | yo'q | default `"UTC"` |  |
| `recipients` | string (email)[] | yo'q | default `[]` |  |
| `enabled` | boolean | yo'q | default `true` |  |

**Javob `200`:** 

```json
{
  "id": "sch_1",
  "reportType": "ACTIVITY",
  "cron": "0 6 * * 1",
  "nextRunAt": "2026-09-14T06:00:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — reports = FULL is required (§6.4). · `422` INVALID_CRON_EXPRESSION — "not a cron" is not a valid 5-field cron expression.

---

### `PATCH /api/reports/schedules/{id}`

**Nima qiladi:** Hisobot jadvalini yangilaydi (`enabled`, `cron` va h.k.).

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `ReportsController_updateSchedule` · original: _Updates a report schedule (e.g. toggle `enabled`, change `cron`)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Body** (`application/json`):

| Maydon | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|
| `reportType` | `IFTA` \| `ACTIVITY` \| `DVIR` \| `FMCSA_PACK` \| `RODS` \| `IDLE_FUEL` | yo'q |  |  |
| `format` | `CSV` \| `PDF` \| `XLSX` | yo'q | default `"CSV"` |  |
| `params` | object | yo'q | default `{}` |  |
| `cron` | string | yo'q | ≥ 1 belgi |  |
| `timezone` | string | yo'q | default `"UTC"` |  |
| `recipients` | string (email)[] | yo'q | default `[]` |  |
| `enabled` | boolean | yo'q | default `true` |  |

**Javob `200`:** 

```json
{
  "id": "sch_1",
  "enabled": false
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` REPORT_SCHEDULE_NOT_FOUND — Report schedule not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `DELETE /api/reports/schedules/{id}`

**Nima qiladi:** Hisobot jadvalini o'chiradi; yaratilgan hisobotlar qoladi.

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `ReportsController_deleteSchedule` · original: _Deletes a report schedule. Reports it already generated are kept._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `204`:** Deleted.

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — reports = FULL is required (§6.4). · `404` REPORT_SCHEDULE_NOT_FOUND — Report schedule not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/reports/ifta`

**Nima qiladi:** Chorak uchun IFTA hisobotini navbatga qo'yadi (`?format=PDF` → PDF).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/reports-ifta', 'title': 'Reports · IFTA', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.20'}`
- **operationId:** `ReportsController_ifta` · original: _Shortcut: queues an IFTA report for a quarter (TZ §11.6 `/reports/ifta?quarter=`). `?format=PDF` (B-96) queues the PDF instead of the CSV — still READ, no FULL required._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `jurisdiction` | query | string | yo'q | pattern `^[A-Za-z]{2}$` | Two-letter code from `GET /reports/ifta/jurisdictions`. |
| `vehicleGroupId` | query | string (uuid) | yo'q |  | Only units in this vehicle group (`GET /vehicle-groups`). |
| `vehicleId` | query | string (uuid) | yo'q |  |  |
| `quarter` | query | string | ha | pattern `^\d{4}-Q[1-4]$` |  |
| `format` | query | `CSV` \| `PDF` | yo'q |  |  |

**Javob `202`:** Queued.

```json
{
  "reportId": "rpt_2",
  "status": "QUEUED"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — quarter must look like 2026-Q3.

---

### `GET /api/reports/ifta/jurisdictions`

**Nima qiladi:** W-12 `Jurisdiction` menyusi uchun IFTA yurisdiksiyalari (AQSh, keyin Kanada).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/reports-ifta', 'title': 'Reports · IFTA', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.20'}`
- **operationId:** `ReportsController_iftaJurisdictions` · original: _IFTA jurisdictions for the W-12 `Jurisdiction` menu — every US state / Canadian province code an IftaSegment can carry (US first, then Canada, each by name). Declared before GET /reports/:id._

**Javob `200`:** 

```json
{
  "items": [
    {
      "code": "AL",
      "name": "Alabama",
      "country": "US"
    },
    {
      "code": "ON",
      "name": "Ontario",
      "country": "CA"
    }
  ]
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/reports/ifta/summary`

**Nima qiladi:** W-12 uchun JSON IFTA chorak xulosasi: yurisdiksiya jami, flot MPG, oldingi chorak bilan solishtirish.

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/reports-ifta', 'title': 'Reports · IFTA', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.20'}`
- **operationId:** `ReportsController_iftaSummary` · original: _JSON IFTA quarter summary for the W-12 screen (gap B-46) — jurisdiction totals, fleet MPG and the vs-prev-quarter chip, read directly from the same IftaSegment/FuelPurchase totals the CSV export uses. Declared before GET /reports/:id so it is never swallowed by the id param route._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `jurisdiction` | query | string | yo'q | pattern `^[A-Za-z]{2}$` | Two-letter code from `GET /reports/ifta/jurisdictions`. Narrows rows, miles, gallons and receipts to it; fleet MPG stays fleet-wide. |
| `vehicleGroupId` | query | string (uuid) | yo'q |  | Only units in this vehicle group (`GET /vehicle-groups`). 404 VEHICLE_GROUP_NOT_FOUND if unknown. |
| `vehicleId` | query | string (uuid) | yo'q |  |  |
| `quarter` | query | string | ha | pattern `^\d{4}-Q[1-4]$` |  |

**Javob `200`:** 

```json
{
  "quarter": "2026-Q3",
  "unitCount": 12,
  "kpis": {
    "totalMiles": 48213,
    "taxableMiles": 48213,
    "taxablePct": 100,
    "fuelGal": 6021.4,
    "receiptCount": 312,
    "fleetMpg": 8.01,
    "fleetMpgPrev": 7.86
  },
  "rows": [
    {
      "jurisdiction": "CA",
      "totalMiles": 9120,
      "taxableMiles": 9120,
      "fuelGal": 1138.9,
      "mpg": 8.01,
      "taxDueUsd": null
    }
  ],
  "totals": {
    "totalMiles": 48213,
    "taxableMiles": 48213,
    "fuelGal": 6021.4,
    "mpg": 8.01,
    "taxDueUsd": null
  }
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` VEHICLE_GROUP_NOT_FOUND — Vehicle group not found. · `422` VALIDATION_FAILED — quarter must look like 2026-Q3.

---

### `GET /api/reports/activity`

**Nima qiladi:** Sana oralig'i uchun activity hisobotini navbatga qo'yadi (`?format=PDF` → PDF).

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `ReportsController_activity` · original: _Shortcut: queues an activity report for a date range. `?format=PDF` (B-96) queues the PDF instead of the CSV — still READ, no FULL required._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `format` | query | `CSV` \| `PDF` | yo'q |  |  |
| `from` | query | string | ha | pattern `^\d{4}-\d{2}-\d{2}$` |  |
| `to` | query | string | ha | pattern `^\d{4}-\d{2}-\d{2}$` |  |
| `driverId` | query | string (uuid) | yo'q |  |  |

**Javob `202`:** Queued.

```json
{
  "reportId": "rpt_3",
  "status": "QUEUED"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — from/to must be YYYY-MM-DD.

---

### `GET /api/reports/activity/summary`

**Nima qiladi:** W-13/W-15/dashboard uchun haydovchilar bo'yicha JSON activity agregati.

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `ReportsController_activitySummary` · original: _JSON per-driver activity aggregate for W-13/W-15/dashboard (gap B-46) — the web previously fanned out one GET /logs/:driverId/range call per driver (308 calls, 3s→15s in QA). Computed in SQL from DailyLog + HosViolation, never per-driver RODS rebuilds, and never loads EldEvent rows. Declared before GET /reports/:id so it is never swallowed by the id param route._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `groupBy` | query | `driver` \| `vehicleGroup` | yo'q |  | `driver` (default): one row per driver. `vehicleGroup`: one row per group of the driver's currently assigned unit — `{ groupId, name, drivers, days, offSec, sbSec, drivingSec, onSec, distanceMi, violations, certifiedDays }`, `groupId: null` / `name: "Ungrouped"` for drivers with no unit or an ungrouped unit. |
| `vehicleGroupId` | query | string (uuid) | yo'q |  | Only drivers whose currently assigned unit is in this vehicle group. |
| `to` | query | string | ha | pattern `^\d{4}-\d{2}-\d{2}$` |  |
| `from` | query | string | ha | pattern `^\d{4}-\d{2}-\d{2}$` |  |
| `driverId` | query | string (uuid) | yo'q |  |  |
| `terminal` | query | string | yo'q | ≥ 1 belgi |  |
| `status` | query | `ACTIVE` \| `INACTIVE` \| `TERMINATED` | yo'q |  |  |
| `sort` | query | string | yo'q | default `"name:asc"`, pattern `^(name|days|offSec|sbSec|drivingSec|onSec|distanceMi|violations|certifiedDays):(asc|desc)$` |  |
| `page` | query | integer | yo'q | ≥ 1, default `1` |  |
| `limit` | query | integer | yo'q | 1–200, default `25` |  |

**Javob `200`:** 

```json
{
  "kpis": {
    "drivingSec": 412200,
    "drivingDeltaPct": 4.2,
    "onDutySec": 88200,
    "distanceMi": 18412,
    "violations": 3,
    "violationsDelta": -1
  },
  "items": [
    {
      "driverId": "drv_1",
      "name": "Doe, John",
      "days": 8,
      "offSec": 172800,
      "sbSec": 28800,
      "drivingSec": 39600,
      "onSec": 7200,
      "distanceMi": 512,
      "violations": 0,
      "certifiedDays": 8
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 264,
  "totalPages": 11
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — from/to must be YYYY-MM-DD and the range must not exceed 366 days.

---

### `GET /api/reports/dvir`

**Nima qiladi:** Sana oralig'i uchun DVIR hisobotini navbatga qo'yadi (`?format=PDF` → PDF).

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `ReportsController_dvir` · original: _Shortcut: queues a DVIR report for a date range. `?format=PDF` (B-96) queues the PDF instead of the CSV — still READ, no FULL required._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `format` | query | `CSV` \| `PDF` | yo'q |  |  |
| `from` | query | string | ha | pattern `^\d{4}-\d{2}-\d{2}$` |  |
| `to` | query | string | ha | pattern `^\d{4}-\d{2}-\d{2}$` |  |
| `vehicleId` | query | string (uuid) | yo'q |  |  |

**Javob `202`:** Queued.

```json
{
  "reportId": "rpt_4",
  "status": "QUEUED"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — from/to must be YYYY-MM-DD.

---

### `GET /api/reports/fmcsa-pack`

**Nima qiladi:** Sana oralig'i uchun FMCSA compliance paketini navbatga qo'yadi (har haydovchi Appendix A fayli + PDF muqova).

- **Auth:** `Authorization: Bearer <access token>`
- **Ekran:** `{'id': 'web/reports-fmcsa-audit-pack', 'title': 'Reports · FMCSA / DOT audit pack', 'source': 'eld.docs/web/OneBook-ELD-admin.pdf p.21'}`
- **operationId:** `ReportsController_fmcsaPack` · original: _Shortcut: queues an FMCSA compliance package (Appendix A output files per driver + PDF cover) for a date range._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `from` | query | string | ha | pattern `^\d{4}-\d{2}-\d{2}$` |  |
| `to` | query | string | ha | pattern `^\d{4}-\d{2}-\d{2}$` |  |
| `driverId` | query | string (uuid) | yo'q |  |  |
| `vehicleId` | query | string (uuid) | yo'q |  |  |
| `include` | query | `RODS` \| `UNIDENTIFIED` \| `EDITS` \| `ELD_ID` \| `DVIR` \| `MALFUNCTIONS`[] | yo'q | ≥ 1 ta |  |

**Javob `202`:** Queued.

```json
{
  "reportId": "rpt_5",
  "status": "QUEUED"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `422` VALIDATION_FAILED — from/to must be YYYY-MM-DD.

---

### `GET /api/reports/{id}`

**Nima qiladi:** Hisobot ishi holati; READY bo'lsa 7 kunlik presigned yuklash URL'i.

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `ReportsController_get` · original: _Report job status and, once READY, a fresh 7-day presigned download URL (TZ §15/§17)._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "id": "rpt_1",
  "type": "IFTA",
  "status": "READY",
  "rowCount": 12,
  "completedAt": "2026-09-11T06:01:00.000Z"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` REPORT_NOT_FOUND — Report not found. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/reports/{id}/download`

**Nima qiladi:** READY hisobot uchun yangi presigned URL (7 kun). Tayyor bo'lmasa 409.

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `ReportsController_download` · original: _Fresh presigned GET URL for a READY report (7-day TTL, TZ §15). 409 if not ready yet._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** 

```json
{
  "downloadUrl": "https://minio.local/reports/rpt_1.csv?X-Amz-Signature=...",
  "expiresAt": "2026-09-18T06:01:00.000Z",
  "fileName": "rpt_1.csv"
}
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` REPORT_NOT_FOUND — Report not found. · `409` REPORT_NOT_READY — Report is not ready for download yet. · `422` VALIDATION_FAILED — Request validation failed.

---

### `GET /api/reports/{id}/file`

**Nima qiladi:** READY hisobot faylini API orqali yuklab beradi (`text/csv` yoki `application/pdf`). Web shuni ishlatadi.

- **Auth:** `Authorization: Bearer <access token>`
- **operationId:** `ReportsController_file` · original: _Downloads a READY report file through the API (attachment, `text/csv` or `application/pdf`). The web panel uses this instead of the presigned URL, which points at an object-storage host the browser may not reach. 409 if not ready yet._

**Parametrlar:**

| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |
|---|---|---|---|---|---|
| `id` | path | string | ha |  |  |

**Javob `200`:** The report file itself. Not wrapped in the success envelope.

```json
"Jurisdiction,Total miles,Taxable miles\nOH,42,42\n"
```

**Xatolar:** `401` UNAUTHORIZED — Authentication required. · `403` FORBIDDEN — Insufficient permissions for this action. · `404` REPORT_NOT_FOUND — Report not found. · `409` REPORT_NOT_READY — Report is not ready for download yet. · `422` VALIDATION_FAILED — Request validation failed.

---
