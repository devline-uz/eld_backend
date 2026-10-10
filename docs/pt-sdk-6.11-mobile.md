# Pacific Track SDK 6.11.1 — backend o'zgarishlari (MOBILE ilova uchun) · 2026-10-10

Manba: `PT30_PT40_HOS_SDK.pdf`, `pt-sdk-6.11.1_android.zip` (AAR, javadoc, Eldman), `6.11.1_ios.zip` (PacificTrack.xcframework, DeviceManager, jazzy docs).
Backend: branch `claude/2026-10-10-eld-pt-sdk-6-11` → `main`. Qarorlar: D-133, D-135. Migratsiya `20261010100000_pt_sdk_6_11`.
Bu hujjat `mobile/future.md` F-2 (SDK) va F-34 (telemetriyada lat/lon majburiy) bandlarini yopadi.

Barcha javoblar `{ data: ... }` konvertida, prefiks `/api`.
Barcha `/ingest/*` route'lari **DriverGuard**: boshqa token bo'lsa → `403 DRIVER_CONTEXT_REQUIRED`. Hammasi bitta per-driver `ingest` throttle bucket'ida (300 req/min).

## 0. Asosiy model: SDK nima beradi, ilova nima hisoblaydi

- SDK **§395 Appendix A hodisalarini bermaydi**, faqat xom `TelemetryEvent`/`EventFrame` beradi.
- D/ON, intermediate log, power-up/shutdown, malfunction/diagnostic yozuvlarini **ilova hisoblaydi** va avvalgidek `POST /ingest/events` ga yuboradi. Bu endpoint **o'zgarmagan**.
- Yangi narsa shuki, xom SDK hodisalarining o'zi ham serverga ketadi (`POST /ingest/device-events`). Bu audit uchun, va undan harsh hodisalar Safety'ga tushadi.

Ma'lumot oqimi:

| SDK manbasi | Backend endpoint |
|---|---|
| `TelemetryEvent` / `EventFrame` (live va stored) | `POST /ingest/device-events` (yangi) |
| Ilova hisoblagan Appendix A hodisa | `POST /ingest/events` (o'zgarmagan) |
| `VirtualDashboard` snapshot + `DtcData` | `POST /ingest/telemetry` (kengaydi) |
| `TrackerInfo` + `GetVehicleInfo` + stored count | `POST /ingest/device-status` (kengaydi) |
| BLE / USB ulanish holati | `POST /ingest/ble-state` (kengaydi) |
| `SetSystemVar` uchun qiymatlar | `GET /mobile/device-config` (yangi) |

---

## 1. YANGI · `POST /ingest/device-events`

SDK'ning xom hodisalari: power, ignition, engine, trip, periodic, BLE, bus, MEMS harsh.

**Cheklovlar:** body ≤ 1 MB (aks holda `413 PAYLOAD_TOO_LARGE`), `events` 1–500 ta, butun batch bitta tranzaksiyada.

**Body:**

| Maydon | Tur | Majburiy | Izoh |
|---|---|---|---|
| `deviceSerial` | string 1–60 | ha | `GetTrackerInfo.serialNumber` (advertised nomdan emas) |
| `vehicleId` | uuid | ha | Juftlangan unit |
| `events[]` | array 1–500 | ha | |
| `events[].type` | string 1–40 | ha | SDK nomi istalgan registrda (`EV_MEMS_BRK`), bizning enum (`HARSH_BRAKE`) yoki `EV_`siz nom. Noma'lum → `UNKNOWN` sifatida saqlanadi, 400 bermaydi |
| `events[].seq` | int 0–2147483647 | ha | `mSeq` / `sequenceNumber` (kun ichidagi raqam) |
| `events[].hsi` | int ≥ 0 | yo'q | `mHsi` (HOS sequence index, SDK 6.10+) |
| `events[].occurredAt` | ISO datetime | ha | `mDateTime` / `datetime` (UTC) |
| `events[].live` | boolean | ha | `liveEvent`; stored (unidentified) hodisa uchun `false` |
| `events[].latitude` | number −90..90 | yo'q | GPS lock bo'lmasa `null` |
| `events[].longitude` | number −180..180 | yo'q | |
| `events[].headingDeg` | int 0–359 | yo'q | |
| `events[].gpsLocked` | boolean | yo'q | `isLocked` |
| `events[].gpsSatellites` | int 0–99 | yo'q | |
| `events[].gpsDop` | number 0–999 | yo'q | |
| `events[].gpsAgeSec` | int ≥ 0 | yo'q | |
| `events[].odometerKm` | number yoki raqamli string, ≥ 0 | yo'q | Android `mOdometer` string, o'zgartirmasdan yuborish mumkin |
| `events[].speedKmh` | number 0–400 | yo'q | `mVelocity` (km/h). GPS tezligi **knot**da, uni yubormang |
| `events[].engineHours` | number yoki raqamli string, ≥ 0 | yo'q | |
| `events[].rpm` | int 0–10000 | yo'q | |
| `events[].obd2` | boolean | yo'q | |
| `events[].engineAgeSec` | int ≥ 0 | yo'q | |

**`type` xaritasi:**
- `EV_POWER_ON/OFF`, `EV_IGNITION_ON/OFF`, `EV_ENGINE_ON/OFF`, `EV_TRIP_START/END`, `EV_PERIODIC`, `EV_BLE_ON/OFF`, `EV_BUS_ON/OFF`, `EV_INTERMEDIATE` → `EV_`siz nom.
- `EV_MEMS_ACC` → `HARSH_ACCEL`, `EV_MEMS_BRK` → `HARSH_BRAKE`, `EV_MEMS_COR` → `HARSH_CORNER`, `EV_UNKNOWN` → `UNKNOWN`.
- iOS `EventType` nomlarini ham shu nomlarga o'girib yuboring: `powerOn` → `POWER_ON`, `harshBraking` → `HARSH_BRAKE` va h.k.

Misol:

```json
{
  "deviceSerial": "PT30_A86E",
  "vehicleId": "6f1c…",
  "events": [
    { "type": "EV_ENGINE_ON", "seq": 41, "hsi": 812, "occurredAt": "2026-10-10T13:02:11Z", "live": true,
      "latitude": 41.311, "longitude": -72.93, "gpsLocked": true, "gpsSatellites": 9, "gpsDop": 1.1,
      "odometerKm": "182344.6", "speedKmh": 0, "engineHours": "8123.4", "rpm": 650 },
    { "type": "EV_MEMS_BRK", "seq": 42, "occurredAt": "2026-10-10T13:20:40Z", "live": true, "speedKmh": 72 }
  ]
}
```

**Javob:**

```json
{ "received": 2, "stored": 2, "duplicates": 0, "safetyEvents": 1 }
```

Xuddi shu batch qayta yuborilsa: `{ "received": 2, "stored": 0, "duplicates": 2, "safetyEvents": 0 }`.

**Xatolar:**
- `404 UNKNOWN_DEVICE`: serial ro'yxatda yo'q.
- `403`: qurilma `vehicleId` ga juftlanmagan, yoki haydovchi unitga biriktirilmagan va unda ochiq sessiyasi yo'q.
- `404 VEHICLE_NOT_FOUND`.
- `422 VALIDATION_FAILED`.

**Server nima qiladi:**
1. `DeviceRawEvent` ga yozadi. Idempotentlik kaliti `(deviceId, occurredAt, seq)`, ya'ni SDK'ning ACK kaliti (seq + sana). **Javob kelgandan keyin** stored hodisani qurilmada ACK qiling (Android `AckStoredEvent`, iOS `processed(true)`). Qayta yuborish xavfsiz.
2. Koordinatalar qo'pollashtiriladi: 1 mil, Personal Conveyance'da 10 mil.
3. Haydovchini aniqlash:
   - live hodisa → yuborgan haydovchi;
   - stored (`live: false`) HARSH → §7.4 qoidasi (ochiq sessiya bo'lsa o'sha haydovchi, bo'lmasa `null`);
   - boshqa stored hodisalar → `null`.
4. Faqat yangi yozilgan `HARSH_*` → `SafetyEvent` (`HARSH_ACCEL` / `HARSH_BRAKING` / `HARSH_TURN`) + realtime `safety.event_created` + `alert.harsh_event`.
5. `Device.lastSeenAt = now`; `lastEventAt` faqat oldinga siljiydi.

**Tavsiya:**
- Periodic hodisalar ko'p bo'ladi. Ularni yig'ib, ≤ 500 talik batch bilan har 60 s da yoki ulanish tiklanganda yuboring.
- Offline'da outbox'da saqlang. Endpoint idempotent, shuning uchun `idempotent: true`.

## 2. YANGI · `GET /mobile/device-config?serial=`

Ilova qurilmaga `SetSystemVar` bilan yozadigan qiymatlar.

**Query:** `serial`, string 1–60, majburiy.

**Ruxsat:** qurilma haydovchi biriktirilgan (yoki unda ochiq sessiyasi bor) unitga juftlangan bo'lishi kerak.

**Xatolar:**
- `404 UNKNOWN_DEVICE`;
- `403`: juftlanmagan yoki haydovchi bog'lanmagan;
- `422`: serial yo'q.

**Javob:**

```json
{
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
}
```

| Kalit | SDK (Android `SystemVar` / iOS `SystemVariable`) | Diapazon |
|---|---|---|
| `PERIODIC_EVENT_GAP` | `PERIODIC_EVENT_GAP` / `timeBetweenPeriodicEvents` | 2–7200 s |
| `PERIODIC_EVENT_GAP_NOBLE` | `PERIODIC_EVENT_GAP_NOBLE` | 10–480 s |
| `EVENTS_STORED` | `EVENTS_STORED` / `storeEventsInFlash` | doim 1 (unidentified driving uchun shart) |
| `DRIVING_ACCL` | `DRIVING_ACCL` / `drivingAcceleration` | 0–8192 mG, 0 = o'chiq |
| `DRIVING_BRAKING` | `DRIVING_BRAKING` / `drivingBraking` | 0–8192 mG |
| `DRIVING_CORNERING` | `DRIVING_CORNERING` / `drivingCornering` | 0–8192 mG |
| `HSI_MODE` | `HSI_MODE` | doim 1 (BLE uzilganda HSI oshadi) |

**Ilova algoritmi:**
1. Ulanishdan keyin (`didSync` / `onTrackerReady`) `GET /mobile/device-config` ni chaqiring.
2. Har bir qiymatni `GetSystemVar` bilan solishtiring; farq qilsa `SetSystemVar`.
3. Muvaffaqiyatli `configVersion`ni lokal saqlang.
4. `POST /ingest/device-status` javobida ham `systemVars` + `configVersion` keladi. Versiya o'zgarsa, 2-qadamni takrorlang. Alohida polling kerak emas.
5. Qiymatlarni dispetcher web'dan o'zgartiradi (W-20).

## 3. KENGAYDI · `POST /ingest/telemetry` (Virtual Dashboard)

Javob o'zgarmagan: `{ accepted, duplicates, denserThanContract }`. Downsampling (1 nuqta / 60 s) avvalgidek.

**O'zgargan maydonlar:**

| Maydon | Endi | Avval |
|---|---|---|
| `latitude`, `longitude` | **ixtiyoriy / null**. GPS lock yo'q (`isLocked=false`) nuqtalarni ham yuboring. Faqat bittasi bo'lsa, pozitsiyasiz saqlanadi (F-34 yopildi) | majburiy |
| `loadPct` | int 0–**250** (SDK `engineLoad` 0–250 %) | 0–100 |
| `gear` | int −1..255 **yoki** string ≤ 8 (SDK `gear` int 0–31) | string |
| `busType` | `J1939`/`J1708`/`OBD_II`; `OBDII`, `OBD2`, `OBD-II` (har qanday registr); raqam `1`=OBD_II, `2`=J1708, `4`=J1939 (VDB `bus`). Noma'lum → `null` | faqat enum |

**Yangi ixtiyoriy maydonlar** (barchasi metrik, SDK `VirtualDashboard.Snapshot` / iOS `VirtualDashboardData`):

| Maydon | Tur | SDK |
|---|---|---|
| `intakePressureKpa` | 0–9999 | `intakePressure` |
| `barometerKpa` | 0–999 | `ambientPressure` / `barometer` |
| `fuelTempC` | int −60..250 | `fuelTankTemperature` / `engineFuelTankTemperature` |
| `intercoolerTempC` | int −60..250 | `intercoolerTemperature` |
| `turboOilTempC` | int −60..250 | `turboOilTemperature` |
| `retarderPct` | int −125..125 | `retarderPercent` |
| `brakePedal` | int 0–255 | `brakePedal` |
| `odometerComputed` | boolean | `computedOdometer` / `odometerComputed` |
| `engineHoursComputed` | boolean | `computedEngineHours` / `engineHoursComputed` |
| `gpsLocked` | boolean | `isLocked` |
| `gpsSatellites` | int 0–99 | `sateliteCount` |
| `gpsDop` | 0–999 | `dop` |
| `gpsAgeSec` | int ≥ 0 | `gpsAge` |
| `vin` | string ≤ 20 | VDB `VIN`. Nuqtaga yozilmaydi, eng oxirgisi `Device.reportedVin` ga yoziladi |
| `milOn` | boolean | `DtcData.getMil()` / `DTCErrorCodes.mil`. Shu nuqtaning DTC qatorlariga qo'llanadi |

**`dtcCodes[]`** endi max 50 ta. Har bir element (hammasi ixtiyoriy):

| Maydon | Tur | J1939 fault map | J1708 fault map | OBD-II fault map |
|---|---|---|---|---|
| `spn` | int 0–999999 | `SPN` | `SID_PID` (raqam) | — |
| `fmi` | int 0–31 | `FMI` | `FMI` | — |
| `code` | string 1–20 | — | ixtiyoriy (`SID 254` / `PID 84`) | `Code` (`P0301`) |
| `occurrence` | int 0–255 | `OccurrenceCount` | `OccurrenceCount` | — |
| `bus` | `busType` bilan bir xil yozilishlar | `J1939` | `J1708` | `OBD_II` |
| `conversionMethod` | 0/1 | `ConversionMethod` | — | — |
| `isSid` | boolean | — | `isSID` | — |
| `active` | boolean | — | `isActive` | — |
| `source`, `description` | ≤ 40, ≤ 200 | ixtiyoriy | | |

**DTC'lar qanday birlashtiriladi:**
- J1939: `(spn, fmi)` bo'yicha. J1708: `SID n`/`PID n` + `fmi` bo'yicha (`code` bo'lmasa `spn` + `isSid`dan quriladi). OBD-II: katta harfli `code` bo'yicha.
- `bus` yuborilmasa: SPN'siz kod → OBD-II, boshqasi → J1939.
- `dtcCount` (VDB `dtcNo`) avvalgidek.

## 4. KENGAYDI · `POST /ingest/device-status`

Yangi ixtiyoriy body maydonlari (eskilari: `deviceSerial`, `storedEventsCount`, `firmware`, `sdkVersion`, `recordsLost`, `consecutiveTransferFailures` o'zgarmagan):

| Maydon | Tur | SDK |
|---|---|---|
| `mainFirmware` | ≤ 20 | `TrackerInfo.mainVersion` / `mvi`. `firmware`ning aliasi, ikkalasi kelsa `mainFirmware` ustun |
| `bleFirmware` | ≤ 20 | `bleVersion` / `bvi` |
| `productName` | ≤ 40 | `productName` / `product` (`PT30`, `PT40-C`) |
| `imei` | ≤ 20 | `imei` (PT40) |
| `reportedVin` | ≤ 20 | `TrackerInfo.vin` (PT30) yoki `GetVehicleInfo.vin`. Katta harfga o'giriladi |
| `connectionType` | `BLE` \| `USB` | Android USB rejimi |
| `busType` | telemetriya bilan bir xil yozilishlar | `GetVehicleInfo.bus` |
| `appPlatform` | `IOS` \| `ANDROID` | |

**Javob:**

```json
{
  "storedEventsCount": 12,
  "backlogAlert": false,
  "codes": [],
  "model": "PT40",
  "vinMismatch": false,
  "systemVars": { "PERIODIC_EVENT_GAP": 30, "PERIODIC_EVENT_GAP_NOBLE": 30, "EVENTS_STORED": 1, "DRIVING_ACCL": 0, "DRIVING_BRAKING": 0, "DRIVING_CORNERING": 0, "HSI_MODE": 1 },
  "configVersion": "3f9a1c0b7d2e"
}
```

**Server nima qiladi:**
- Har bir yuborilgan maydonni Device'ga yozadi; `lastInfoAt = now`.
- `productName` `PT40…` (masalan `PT40-C`) → `model = PT40`, `PT30…` → `PT30`.
- `vinMismatch: true`: `reportedVin` juftlangan unit VIN'idan farq qiladi. **Bloklamaydi.** Har yangi VIN uchun bir marta `alert.device_vin_mismatch` chiqadi.

**Ilovaga tavsiya:**
- `didSync`/`TrackerInfo` olingandan keyin va har heartbeat'da (stored count bilan) yuboring.
- `vinMismatch` bo'lsa, S-04 / M-20 da ogohlantirish ko'rsating: "This ELD reports a different VIN than the selected unit".

## 5. KENGAYDI · `POST /ingest/ble-state`

- Yangi ixtiyoriy maydon: `connectionType: 'BLE' | 'USB'`.
- Javob: `{ bleState, connectionType, disconnectedAlert }`. `connectionType`: yuborilgan qiymat, bo'lmasa saqlangani, bo'lmasa `null`.

## 6. O'zgarmagan, lekin eslatma

- `POST /ingest/events` (Appendix A): o'zgarmagan. Stored hodisalar `wasStoredOnDevice: true` bilan.
- Integratsiya uchun SDK talablari (`mobile/` tomoni, backendga ta'sir qilmaydi):
  - Android `minSdk 28`;
  - Nordic BLE 2.11 dependencies;
  - scan va connect native'da (Android `TrackerManager`, iOS `TrackerService.handle(CBPeripheral)`), NUS UUID `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`;
  - PT web services / OTA uchun API key sotuvchidan olinadi.

## 7. Qisqa tekshiruv ro'yxati (mobile)

- [ ] `POST /ingest/device-events` batcher (live + stored, ACK javobdan keyin)
- [ ] `GET /mobile/device-config` → `SetSystemVar`, `configVersion` keshi
- [ ] Telemetriya: GPS'siz nuqtalarni ham yuborish, yangi VDB maydonlari, `dtcCodes[]` bus formatlari, `milOn`, `vin`
- [ ] `device-status`: TrackerInfo maydonlari, `vinMismatch` UI, `systemVars` qayta qo'llash
- [ ] `ble-state`: `connectionType` (USB rejimi)
- [ ] OpenAPI: `backend/docs/openapi.json` (268 operatsiya) dan tiplarni yangilash
