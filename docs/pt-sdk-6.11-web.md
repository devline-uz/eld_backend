# Pacific Track SDK 6.11.1 — backend o'zgarishlari (WEB panel uchun) · 2026-10-10

Manba: `PT30_PT40_HOS_SDK.pdf`, `pt-sdk-6.11.1_android.zip`, `6.11.1_ios.zip` (loyiha ildizida).
Backend: branch `claude/2026-10-10-eld-pt-sdk-6-11` → `main`. Qarorlar: D-133 (schema), D-135 (kod). Buglar: B-155, B-156.
Migratsiya: `20261010100000_pt_sdk_6_11` (faqat qo'shimcha, dev DB'ga qo'llangan).

Barcha javoblar odatdagidek `{ data: ... }` konvertida. Prefiks `/api`.

## Qisqacha: nima o'zgardi va web'ga nima kerak

| # | O'zgarish | Web'da qayerda | Majburiymi |
|---|---|---|---|
| 1 | Qurilma (Device) javobida SDK'dan keladigan yangi maydonlar: `productName`, `bleFirmware`, `imei`, `reportedVin`, `sdkVersion`, `appPlatform`, `connectionType`, `busType`, `lastInfoAt`, `systemVars` | W-20 ELD devices jadvali va drawer'i, W-04 Unit profile → ELD device | Ixtiyoriy, lekin tavsiya etiladi |
| 2 | Qurilma sozlamalari: `periodicNoBleSec`, `harshAccelMg`, `harshBrakeMg`, `harshCornerMg` | W-20 Add/Edit device modali (11.x) | Ixtiyoriy |
| 3 | DTC (nosozlik kodlari) qatorida `code`, `bus`, `milOn`, `conversionMethod`, `active` | W-04 / W-05 Unit → Diagnostics (DTC) ro'yxati | **Ha**: OBD-II/J1708 kodlarda `spn` endi `null` bo'ladi |
| 4 | Telemetriya nuqtasida `latitude/longitude` endi `null` bo'lishi mumkin | W-05 Unit histories, `GET /vehicles/:id/telemetry` | **Ha**: `null`ni xaritaga 0,0 qilib qo'ymang |
| 5 | Qurilmaning o'zi aniqlagan harsh hodisalar (`SafetyEvent`) | W-10 Safety: yangi qatorlar odatdagi `HARSH_*` turlarida keladi | O'zgarish shart emas |
| 6 | Yangi alert: `alert.device_vin_mismatch` | Notifications inbox, W-21 Alert rules | Matnni ko'rsatish yetarli |

---

## 1. `GET /devices` va `GET /devices/:id`: yangi maydonlar

Ruxsat: o'zgarmagan (`devices` READ). Eski maydonlarning hammasi joyida, quyidagilar **qo'shildi**:

| Maydon | Tur | Manba / ma'nosi |
|---|---|---|
| `productName` | `string \| null` | SDK `TrackerInfo.productName`, xom qiymat: `PT30`, `PT40-C`. `model` (`PT30`/`PT40`) shundan normallashtiriladi |
| `bleFirmware` | `string \| null` | BLE chip proshivkasi (`TrackerInfo.bleVersion`). Asosiy proshivka avvalgidek `firmware` maydonida |
| `imei` | `string \| null` | Faqat PT40 da bor |
| `reportedVin` | `string \| null` | Qurilma shinadan o'qigan VIN. Unit VIN'idan farq qilsa, VIN mismatch alerti chiqadi |
| `sdkVersion` | `string \| null` | Haydovchi ilovasidagi PT SDK versiyasi (masalan `6.11.1`) |
| `appPlatform` | `'IOS' \| 'ANDROID' \| null` | Qurilmaga qaysi ilova ulangan |
| `connectionType` | `'BLE' \| 'USB' \| null` | Android USB orqali ham ulanadi |
| `busType` | `'J1939' \| 'J1708' \| 'OBD_II' \| null` | Mashina shinasi |
| `lastInfoAt` | ISO `string \| null` | Ilova TrackerInfo'ni oxirgi marta yuborgan vaqt |
| `periodicNoBleSec` | `int` (10–480, default 30) | SDK `PERIODIC_EVENT_GAP_NOBLE`: telefon ulanmaganda periodik hodisa oralig'i, **soniyada** |
| `harshAccelMg` | `int` (0–8192, default 0) | SDK `DRIVING_ACCL`: keskin tezlanish chegarasi, mG. `0` = o'chiq |
| `harshBrakeMg` | `int` (0–8192, default 0) | SDK `DRIVING_BRAKING`: keskin tormoz |
| `harshCornerMg` | `int` (0–8192, default 0) | SDK `DRIVING_CORNERING`: keskin burilish |
| `systemVars` | object | Hisoblangan. Ilova qurilmaga aynan shu qiymatlarni yozadi (pastga qarang) |

`systemVars` misoli:

```json
{
  "PERIODIC_EVENT_GAP": 30,
  "PERIODIC_EVENT_GAP_NOBLE": 30,
  "EVENTS_STORED": 1,
  "DRIVING_ACCL": 0,
  "DRIVING_BRAKING": 450,
  "DRIVING_CORNERING": 0,
  "HSI_MODE": 1
}
```

- `PERIODIC_EVENT_GAP` = `periodicConnectedSec` (2–7200 s).
- `PERIODIC_EVENT_GAP_NOBLE` = `periodicNoBleSec`.
- `DRIVING_*` = `harsh*Mg`.
- `EVENTS_STORED` va `HSI_MODE` doim `1`.

**Web uchun tavsiya (W-20):**
- jadvalda `productName` (yoki `model`), `firmware` / `bleFirmware`, `connectionType` belgisi (BLE/USB);
- drawer'da `imei`, `reportedVin` (unit VIN'idan farq qilsa qizil ogohlantirish), `sdkVersion`, `appPlatform`, `busType`, `lastInfoAt` ("Last info 5 min ago").

## 2. `POST /devices`, `PATCH /devices/:id`, `POST /devices/import`: yangi kirish maydonlari

Ruxsat: `devices` FULL (o'zgarmagan). Yangi ixtiyoriy maydonlar:

| Maydon | Tur | Default (create) | Validatsiya |
|---|---|---|---|
| `periodicNoBleSec` | int | 30 | 10–480 |
| `harshAccelMg` | int | 0 | 0–8192 |
| `harshBrakeMg` | int | 0 | 0–8192 |
| `harshCornerMg` | int | 0 | 0–8192 |

- `periodicDisconnectedMin` hali qabul qilinadi, lekin **eskirgan (legacy)**. SDK bu qiymatni soniyada kutadi, shuning uchun formada `periodicNoBleSec` ishlatilsin (D-133).
- Validatsiya xatosi → `422 VALIDATION_FAILED` (`details` odatdagi formatda).
- Qiymatlar o'zgarsa, haydovchi ilovasi keyingi heartbeat'da (`configVersion` o'zgaradi) yangi qiymatlarni qurilmaga yozadi. Web'dan "qurilmaga yuborish" tugmasi kerak emas.

Modal uchun UI taklifi: "Harsh event thresholds" bo'limi, uchta raqam maydoni (mG), yonida izoh "0 = off · device-side detection (PT30/PT40 accelerometer)". Bunga "Periodic interval (no phone), sec" maydoni ham qo'shiladi.

## 3. `GET /vehicles/:id/dtc`: DTC qatorlari kengaydi

SDK 6.11 shinaga xos DTC beradi. Har bir qatorga qo'shildi:

| Maydon | Tur | Izoh |
|---|---|---|
| `code` | `string \| null` | OBD-II: `P0301`; J1708: `SID 254` yoki `PID 84`; J1939 da odatda `null` |
| `bus` | `'J1939' \| 'J1708' \| 'OBD_II' \| null` | Qaysi shinadan kelgan |
| `milOn` | `boolean \| null` | Check-engine (MIL) chirog'i yoniqmi |
| `conversionMethod` | `0 \| 1 \| null` | Faqat J1939 (SPN conversion method) |
| `active` | `boolean \| null` | Faqat J1708: kod hozir faolmi |

Misollar:

```json
{ "spn": 100, "fmi": 1, "code": null, "bus": "J1939", "milOn": true, "conversionMethod": 0, "active": null, "occurrence": 3 }
{ "spn": null, "fmi": 3, "code": "SID 254", "bus": "J1708", "milOn": false, "active": true, "occurrence": 1 }
{ "spn": null, "fmi": null, "code": "P0301", "bus": "OBD_II", "milOn": true, "occurrence": 1 }
```

**Web'ga kerakli o'zgarish:**
- Ko'rsatish ustuvorligi: `code ?? "SPN {spn} · FMI {fmi}"`.
- `spn` `null` bo'lsa ham qator bo'sh ko'rinmasin.
- `bus`ni kichik badge qilib, `milOn === true`ni "MIL" (qizil) qilib ko'rsating.
- Dublikatlar backend'da birlashtiriladi: J1939 (spn, fmi), J1708 (kod, fmi), OBD-II (kod) bo'yicha. Takroriy ko'rinishda `occurrence` oshadi.

## 4. Telemetriya va xarita: koordinatasiz nuqtalar

PT30 GPS lock bo'lmaganda ham Virtual Dashboard ma'lumot beradi. Endi bunday nuqtalar ham saqlanadi.

| Endpoint | O'zgarish | Web nima qilishi kerak |
|---|---|---|
| `GET /live/fleet` (W-02) | Shakl o'zgarmagan. Pin endi **koordinatasi bor oxirgi nuqtadan** olinadi; tezlik/engine eng oxirgi nuqtadan | Hech narsa |
| `GET /vehicles/:id/histories` (W-05) | `points[].lat/lon` va `segments[].lat/lon` `null` bo'lishi mumkin. Bo'shliqlar eng yaqin fix bilan to'ldiriladi, shuning uchun `null` faqat butun kun fix yo'q bo'lsa chiqadi; label `Unknown location` | `null` nuqtani xaritaga chizmang, polyline'ni uzing |
| `GET /vehicles/:id/telemetry` | `latitude/longitude` `null` bo'lishi mumkin. Yangi ustunlar: `intakePressureKpa`, `barometerKpa`, `fuelTempC`, `intercoolerTempC`, `turboOilTempC`, `retarderPct`, `brakePedal`, `odometerComputed`, `engineHoursComputed`, `gpsLocked`, `gpsSatellites`, `gpsDop`, `gpsAgeSec` | Grafik/jadval ishlatsangiz `null`ni o'tkazib yuboring. Yangi ustunlar metrik (kPa, °C) |
| IFTA, geofence tarixlari | Faqat koordinatali nuqtalar o'qiladi | Hech narsa |

`odometerComputed` / `engineHoursComputed = true` bo'lsa, qiymat shinadan emas, qurilma hisoblagan. Unit profilida "computed" belgisi sifatida ko'rsatish mumkin.

## 5. Safety (W-10): qurilmaning harsh hodisalari

- Qurilmaga `harsh*Mg > 0` qo'yilsa, PT30/PT40 akselerometri `EV_MEMS_ACC/BRK/COR` hodisalarini beradi.
- Ilova ularni `POST /ingest/device-events` ga yuboradi. Backend `SafetyEvent` yaratadi: `HARSH_ACCEL`, `HARSH_BRAKING`, `HARSH_TURN`.
- `severity` = chegara mG / 150 (1–5), `gForce` = chegara / 1000.
- Realtime `safety.event_created` (room `fleet`) va `alert.harsh_event` odatdagidek ishlaydi. **Web'da o'zgarish shart emas.**
- Bir manevr ikki marta sanalmasin deb: qurilma chegarasi > 0 bo'lgan turda tezlikka asoslangan server detektori shu turni o'tkazib yuboradi.
- B-155: telemetriyadan aniqlangan SafetyEvent koordinatalari endi qo'pollashtiriladi (1 mil, PC rejimida 10 mil).

## 6. Yangi alert: `alert.device_vin_mismatch`

- Qurilma o'qigan VIN (`reportedVin`) juftlangan unit VIN'idan farq qilsa (registr va bo'shliqlar hisobga olinmaydi), har yangi VIN uchun bir marta chiqadi.
- Payload: `{ deviceSerial, vehicleId, reportedVin, vehicleVin, driverId }`.
- Inbox matni: "An ELD reported a VIN that does not match its paired vehicle."
- Taklif: bosilganda W-20 ga shu qurilma drawer'i bilan o'tsin.

## 7. Web chaqirmaydigan, lekin bilish foydali endpointlar (haydovchi ilovasi uchun)

- `POST /ingest/device-events`: xom SDK hodisalari (power, ignition, engine, trip, BLE, bus, harsh). Bular §395 yozuvi **emas**, HOS grafigida ko'rinmaydi.
- `POST /ingest/device-status`: TrackerInfo (product, firmware, IMEI, VIN, USB/BLE).
- `GET /mobile/device-config`: qurilmaga yoziladigan `systemVars`.

Batafsil: `docs/pt-sdk-6.11-mobile.md`.

## Tekshirish

`tsc` 0 xato, `npm run build` o'tadi, unit 379/379, e2e (ingest, openapi-contract, mobile) 34/34. `docs/openapi.json` qayta generatsiya qilingan (268 operatsiya). Web tiplari shundan yangilanishi mumkin.
