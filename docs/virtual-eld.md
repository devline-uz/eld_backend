# Virtual ELD (PT Emulator) — backend API (WEB va MOBILE jamoalari uchun) · 2026-10-12

Manba: `pt30_pt40/tz.md` §8–§9. Qarorlar: D-142…D-145. Migratsiyalar: `20261012100000_virtual_eld`, `20261012110000_telemetry_device_id`.
Barcha javoblar `{ data: ... }` konvertida, prefiks `/api`. Haqiqiy PT30/PT40 oqimi **o'zgarmagan**.

## 0. Asosiy qoidalar

- Virtual qurilma = `Device.isVirtual = true`. Serial har doim `^VPT(30|40)_[A-Z0-9]{4,12}$` (masalan `VPT30_A1B2`).
- `V` bilan boshlanadigan serial **faqat** emulator uchun: oddiy `POST /devices` va import uni rad etadi.
- Kalit **samarali yoniq** = env `VIRTUAL_ELD_ALLOWED` ruxsat bergan **va** `Carrier.virtualEldEnabled = true`.
- `VIRTUAL_ELD_ALLOWED` berilmasa: `NODE_ENV !== production` bo'lsa `true`, prod'da `false`.
- Kalit faqat `erodsMode = TEST` da ishlaydi (test ma'lumoti FMCSA ga ketmasligi kerak).
- Kalitni o'chirish ma'lumotni o'chirmaydi. Virtual qurilma yozuvlari oddiy jadvallarda turadi.

## 1. WEB · `GET /carrier`

Yangi maydonlar:

```json
{
  "virtualEldEnabled": true,
  "virtualEldAvailable": true,
  "virtualEldUpdatedAt": "2026-10-12T09:00:00.000Z",
  "virtualEldUpdatedById": "usr_1",
  "virtualEldUpdatedBy": { "id": "usr_1", "name": "Jane Admin" }
}
```

- `virtualEldAvailable: false` → kalitni **yashiring** (muhitda ruxsat yo'q).
- `virtualEldUpdatedBy` — kalitni oxirgi o'zgartirgan back-office foydalanuvchi; hech kim o'zgartirmagan bo'lsa `null`.
- `virtualEldEnabled` — saqlangan qiymat (env ruxsatsiz bo'lsa ham `true` qolishi mumkin; unda `virtualEldAvailable:false`).

## 2. WEB · `PATCH /carrier { virtualEldEnabled: boolean }`

Ruxsat: `carrierSettings:FULL` (mavjud sozlamalar ruxsati).

| Holat | Javob |
|---|---|
| TEST rejimida yoqish/o'chirish | 200, yangilangan carrier (1-banddagi maydonlar bilan) |
| Env ruxsat bermagan holda yoqish | `409 VIRTUAL_ELD_NOT_ALLOWED` |
| `erodsMode=PRODUCTION` da yoqish | `409 VIRTUAL_ELD_REQUIRES_TEST_ERODS` |
| Kalit yoniq turganda `erodsMode: "PRODUCTION"` | `409 VIRTUAL_ELD_REQUIRES_TEST_ERODS` |
| `{ virtualEldEnabled:false, erodsMode:"PRODUCTION" }` birga | 200 (avval o'chadi) |

- O'zgarish audit'ga yoziladi: `carrier.virtual_eld.enabled` / `carrier.virtual_eld.disabled` (eski/yangi qiymat).
- Realtime: `fleet` xonasiga `carrier.updated { virtualEldEnabled, virtualEldAvailable, virtualEldUpdatedAt }`.
- Bir xil qiymatni qayta yuborish → audit ham, realtime ham yo'q.

## 3. WEB · Qurilmalar

- `GET /devices`, `GET /devices/:id`, `GET /devices/export` — har bir qatorda `isVirtual`.
- `GET /devices?virtual=true` — faqat emulatorlar, `?virtual=false` — faqat haqiqiy. Berilmasa — hammasi.
- `POST /devices` serial `V…` bo'lsa → `422 VIRTUAL_SERIAL_RESERVED`.
- `POST /devices/import` da birorta `V…` qator bo'lsa → **butun fayl** `422 VIRTUAL_SERIAL_RESERVED`, hech narsa yozilmaydi;
  `details.serials: [{ index, serial }]`. Export → import qilishdan oldin `isVirtual:true` qatorlarni olib tashlang.

## 4. MOBILE · `GET /mobile/bootstrap` va `GET /mobile/app-config`

```json
{ "virtualEld": { "enabled": false } }
```

- `enabled` — samarali qiymat (env + carrier kaliti). `false` bo'lsa emulatorga ulanmang, ulangan bo'lsa toza uzing
  va "Test rejimi o'chirildi" bannerini ko'rsating (§8.2-3).
- `bootstrap.device.isVirtual` — `true` bo'lsa qurilma yonida **"TEST"** yorlig'i.
- `app-config` public (tokensiz) — virtualEld har so'rovda DB'dan o'qiladi.

## 5. MOBILE · YANGI `POST /mobile/virtual-devices`

DriverGuard. S-04 → scan → `VPT30_A1B2` → PIN → shu chaqiruv → keyin oddiy `/ingest/*` oqimi.

```json
{ "serial": "VPT30_A1B2", "model": "PT30", "firmware": "V1.0.0", "vin": "1FUJGLDR7CLBP8834" }
```

- `firmware`, `vin` ixtiyoriy. Serial katta harfga o'tkaziladi; `VPT30_` ↔ `PT30`, `VPT40_` ↔ `PT40` mos bo'lishi shart (aks holda 422).
- Javob: `GET /devices/:id` dagi Device DTO (`id`, `serial`, `isVirtual:true`, `vehicleId`, `status:"ASSIGNED"`, `systemVars`...). Status 200.
- **Idempotent**: qayta chaqiruv o'sha qurilmani o'zgarishsiz qaytaradi.
- Qurilma haydovchining **joriy unitiga** (`select-vehicle` qilingan) juftlanadi. Boshqa unitda bo'lsa — bu unitga ko'chadi.
  Unitda boshqa **virtual** qurilma bo'lsa — u bo'shatiladi.

| Xato | Qachon |
|---|---|
| `403 VIRTUAL_ELD_DISABLED` | kalit o'chiq yoki env ruxsat bermagan |
| `409 NO_ACTIVE_VEHICLE` | haydovchida joriy unit yo'q |
| `409 DEVICE_ALREADY_PAIRED` | unitda **haqiqiy** PT30/PT40 bor (uni hech qachon siqib chiqarmaymiz) |
| `422 VALIDATION_FAILED` | serial formati / model mos emas |

## 6. MOBILE · Gate (virtual qurilma uchun)

Quyidagilar virtual qurilma uchun kalit o'chiq bo'lsa (yoki env ruxsat bermasa) `403 VIRTUAL_ELD_DISABLED` qaytaradi:
`POST /ingest/events`, `/ingest/device-events`, `/ingest/telemetry`, `/ingest/ble-state`, `/ingest/device-status`,
`GET /mobile/device-config`, `POST /mobile/device/mac`. Haqiqiy qurilmalarga ta'sir yo'q.

- Bu 4xx — **qayta urinmang** (offline navbatni to'xtating, emulatordan uzing). Kalit qayta yoqilganda navbat davom etadi.
- Realtime: `driver:{id}` xonasiga `virtual_eld.changed { enabled }` keladi — darhol §8.2-3 ni qo'llang.
  FCM push **yo'q**: socket uzilgan bo'lsa, ilova bootstrap / app-config yoki birinchi 403 orqali biladi.

## 7. Tozalash (faqat dev)

```bash
npm run virtual-eld:purge -- --before=2026-10-01 --dry-run   # faqat sanaydi
npm run virtual-eld:purge -- --before=2026-10-01
```

- Prod, prod DB yoki `VIRTUAL_ELD_ALLOWED=false` bo'lsa ishlamaydi.
- O'chiradi: virtual qurilmalarning `DeviceRawEvent` va `TelemetryPoint` (`deviceId` bilan, 2026-10-12 dan keyingilar) yozuvlari;
  BLE holatini (`DISCONNECTED`, `storedEventsCount=0`) tiklaydi.
- **Hech qachon** `EldEvent` (Appendix A RODS) va `Device` qatorlarini o'chirmaydi.
