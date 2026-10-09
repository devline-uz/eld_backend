# OneBook ELD — Backend texnik topshirig'i

**Versiya:** 3.1 — single-tenant · PT30 BLE arxitekturasi · muvofiqlik reviziyasidan keyin
**Stack:** NestJS 11 · TypeScript 5 · PostgreSQL 16 · Prisma 6 · Redis · BullMQ · S3/MinIO · Firebase Auth
**Mo'ljal:** AQSh va Kanada bozori · FMCSA 49 CFR Part 395

---

## 0. Bu hujjat haqida

Bu TZ backend uchun **yagona haqiqat manbai**. Ziddiyat bo'lsa tartib shunday:

**FMCSA 49 CFR Part 395 > Pacific Track hujjatlari > shu TZ > Figma dizayni > mavjud kod**

**Manbalar:**
- Figma: `ELD Software new` — 247 ta ekran (admin panel 111, mobil 92, planshet 44)
- Pacific Track hujjatlari: `eld.docs/pt30_docs/` — 6 ta PDF
- Rol qo'llanmalari: `eld.docs/web/*.pdf`

Har bir endpoint kamida bitta ekranga xizmat qilishi kerak. Ekranga bog'lanmagan endpoint yozilmaydi.

### 0.1. v3.0 da nima o'zgardi

| # | O'zgarish | Sabab |
|---|---|---|
| 1 | **ELD internetga ulanmaydi** — mobil ilova gateway | Pacific Track hujjati: PT30 faqat BLE orqali ishlaydi |
| 2 | Qurilma HTTP tokeni olib tashlandi | Qurilma HTTP so'rov yubormaydi |
| 3 | Metrik → imperial konvertatsiya qatlami qo'shildi | PT30 km, km/h, litrda beradi |
| 4 | `odometerOffset` maydoni qo'shildi | PT30 odometri **nisbiy** bo'lishi mumkin |
| 5 | Google Sign-In (Firebase) qo'shildi | Buyurtmachi qarori |
| 6 | SMS kanali **email** bilan almashtirildi | Buyurtmachi qarori, keyinroq SMS'ga ko'chiriladi |
| 7 | eRODS **test rejimida** | FMCSA ro'yxati hali boshlanmagan |
| 8 | SAML olib tashlandi | Kerak emas |
| 9 | Terminal scoping olib tashlandi | Hozircha bitta baza |
| 10 | **Dev DB = prod DB nusxasi** talabi qo'shildi | Buyurtmachi talabi (22.3-bo'lim) |
| 11 | **Real-time** bo'limi kengaytirildi: resume, backoff, FCM push | Buyurtmachi talabi (12-bo'lim) |
| 12 | **Offline** bo'limi kengaytirildi: offline DOT inspeksiyasi, lokal output fayl | Buyurtmachi talabi (13-bo'lim) |
| 13 | **HOS dvigateli ikki tilda** (TS + Dart) + conformance testlar | Offline'da soatlar ishlashi shart (8.6) |

### 0.2. v3.1 da nima tuzatildi

To'liq mantiqiy reviziya natijasi. 24 ta muammo tuzatildi.

| # | Tuzatish | Bo'lim |
|---|---|---|
| 1 | Split sleeper — **ikkala** qism ham 14 soatlik oynadan chiqariladi | 8.2 |
| 2 | Unidentified biriktirilganda `recordOrigin` **1 bo'lib qoladi** | 7.4 |
| 3 | Stored events uchun ustuvorlik tartibi aniq yozildi | 3.1, 7.4 |
| 4 | PC joylashuvi ingest'da 10 milyagacha qo'pollashtiriladi | 5.5, 7.3 |
| 5 | `eventSequenceId` maydoni qo'shildi (Appendix A talabi) | 5.5 |
| 6 | `Driver.homeTerminalTimezone` — RODS kuni shu bo'yicha bo'linadi | 5.3, 8.1 |
| 7 | Google Sign-In endi 2FA ni chetlab o'tmaydi | 6.2 |
| 8 | `previousDays[]` — recap uchun kunlik taqsimot | 8.1 |
| 9 | `HosViolation` kaliti recalc'da barqaror | 5.8, 8.4 |
| 10 | Prisma relationlari to'liq e'lon qilindi | 5.2–5.5 |
| 11 | Timing chegarasi yagona — 10 daqiqa, hodisa rad etilmaydi | 7.3, 7.8 |
| 12 | Hamrox haydovchi — vaqt bilan chegaralangan `CoDriverPairing` | 5.3 |
| 13 | `POST /mobile/hos-state` — drift solishtiruvi uchun | 8.6, 11.8 |
| 14 | `PushToken` jadvali (telefon + planshet) | 5.3, 12.7 |
| 15 | Ruxsat matritsasi 22 kalit bo'yicha to'liq | 6.4 |
| 16 | `SMS` kanali API darajasida rad etiladi | 14 |
| 17 | Sertifikatlanmagan jurnal alerti — yagona chegara (8 kun) | 9.2, 14 |
| 18 | PE oralig'i hamma joyda 30 sek | 3.2 |
| 19 | Qolgan 26 model to'liq yozildi | 5.10 |
| 20 | Output fayl nomi Appendix A 4.8.2.2 bo'yicha | 10.2 |
| 21 | `eldIdentifier` — 6 belgi (`OBK001`, Appendix A 7.15; B-138), `eldRegistrationId` — 4 belgi (7.17) | 5.1, 10.1 |
| 22 | Email uzatish shifrlanadi | 10.4 |
| 23 | Hodisa hajmi bahosi realga keltirildi | 1.2 |
| 24 | Dart dvigateli va conformance bosqichlarga kiritildi | 24 |

Qo'shimcha: `wss://` va header orqali auth (12.2) · dev/prod himoyasi ikki tomonlama (22.3) · seed sanasi nisbiy (22.3) · `IftaSegment` 4 yil (15) · `EldEvent` partition (5.5) · drayverning o'z jurnalini tuzatishi (9.3).

---

## 1. Mahsulot va qamrov

### 1.1. Nima quriladi

Bitta yuk tashuvchi kompaniya uchun ELD platformasi.

| Mijoz | Kim ishlatadi | Asosiy vazifa |
|---|---|---|
| **Web panel** | Back-office (4 rol) | Park, muvofiqlik, hisobot, sozlama |
| **Mobil ilova** | Drayver | HOS, DVIR, sertifikatlash, DOT ko'rigi, **ELD gateway** |
| **Planshet** | Drayver (kabinada) | Xuddi mobil, landshaft rejimida |

### 1.2. Boshlang'ich hajm

| Ko'rsatkich | Bugun | 2 yil ichida |
|---|---|---|
| Unitlar | 69 | 300 gacha |
| Drayverlar | 58 | 250 gacha |
| Back-office foydalanuvchilar | 12 | 40 gacha |
| Bazalar (terminal) | 1 | ? |
| ELD hodisalari / kun | ~1 800 | ~8 000 |
| Telemetriya nuqtalari / kun | ~60 000 | ~260 000 |

**Hodisa hajmi qanday chiqdi:** bir unit uchun kuniga ~10 duty change + ~11 intermediate log (haydash paytida har 60 daq) + ~4 engine power + login/logout ≈ **26 hodisa**. 69 unit → ~1 800/kun. Bu raqam ingest maqsadini ham belgilaydi (19-bo'lim): pik yuk **50 hodisa/sek**, chunki hodisalar batch bo'lib, BLE tiklanganda to'p-to'p keladi.

Telemetriya: unit kuniga ~14 soat harakatda, serverga 60 sekundda bitta nuqta → 69 × 14 × 60 ≈ 58 000. Hajm ilova tomonidagi **downsampling** ga bog'liq — 7.5-bo'limga qarang.

### 1.3. Qamrovga kiradi

ELD hodisalarini qabul qilish · HOS qoidalari dvigateli · RODS (jurnal, tuzatish, sertifikatlash) · aniqlanmagan haydash · malfunction/diagnostic · DVIR va defektlar · ish buyurtmalari · reyslar · IFTA, FMCSA, Activity, DVIR hisobotlari · eRODS uzatish · rollar va audit · real-time kuzatuv · bildirishnomalar · chat · integratsiyalar

### 1.4. Qamrovga kirmaydi

- **Multi-tenant / SaaS** — 27-bo'limda o'tish yo'li
- **Billing va obuna** — mahsulot sotilmaydi
- **SAML** — email + parol + 2FA yetarli
- **SMS** — hozircha email bilan, keyinroq qo'shiladi
- **Terminal bo'yicha scoping** — hozircha bitta baza
- Dashcam, yuk birjasi, Kanada HOS, ish haqi

---

## 2. Terminlar

| Termin | Ma'nosi |
|---|---|
| **ELD** | Electronic Logging Device — dvigatelga ulanadigan qurilma (PT30) |
| **HOS** | Hours of Service — haydash va ish vaqti me'yorlari |
| **RODS** | Records of Duty Status — kunlik ish holati yozuvlari |
| **DVIR** | Driver Vehicle Inspection Report |
| **IFTA** | International Fuel Tax Agreement |
| **eRODS** | FMCSA ning jurnal qabul qiluvchi rasmiy tizimi |
| **BLE** | Bluetooth Low Energy — PT30 va ilova o'rtasidagi aloqa |
| **Gateway** | Mobil ilova — qurilma va server o'rtasidagi ko'prik |
| **Stored events** | Qurilmada BLE uzilganda saqlangan hodisalar |
| **Virtual Dashboard** | PT30 ning dvigatel parametrlari to'plami |
| **Duty status** | OFF / SB / D / ON |
| **PC / YM** | Personal Conveyance / Yard Move |
| **Cycle** | 8 kunlik 70 soatlik limit |

---

## 3. Arxitektura

### 3.1. ⚠️ Eng muhim: ELD internetga ulanmaydi

Pacific Track hujjatiga ko'ra **PT30 faqat BLE orqali ishlaydi**. U SIM karta, Wi-Fi yoki internetga ega emas.

```
┌──────────┐  BLE   ┌─────────────────┐  HTTPS  ┌──────────┐
│  PT30    │◄──────►│  Mobil ilova /  │────────►│ Backend  │
│ (dvigatel│        │    planshet     │         │  NestJS  │
│  ga ulangan)      │   = GATEWAY     │         └──────────┘
└──────────┘        └─────────────────┘
```

**Buning oqibatlari:**

| Oqibat | Tafsilot |
|---|---|
| Qurilma uchun HTTP endpoint **yo'q** | `/ingest/*` faqat ilovadan keladi |
| Qurilma HTTP tokeni **yo'q** | Ilova drayver JWT'si bilan autentifikatsiya qiladi |
| Ilova offline bo'lsa — ma'lumot ilovada turadi | Ikki bosqichli navbat: qurilma → ilova → server |
| Telefon uzoqlashsa — qurilma o'zi saqlaydi | Hodisalar keyin BLE orqali oqib chiqadi. Kimga tegishli ekani **7.4-bo'limdagi ustuvorlik tartibi** bilan hal qilinadi — avtomatik unidentified qilinmaydi |
| Server hodisani **kechikib** oladi | Kechikish soatlab bo'lishi mumkin. Barcha hisoblar `eventDateTime` ga tayanadi, `createdAt` ga emas |

### 3.2. Ma'lumot yo'li — uch holat

**Holat 1 — normal (BLE ulangan, internet bor)**
```
PT30 → BLE (har 30 sek periodic + barcha transition) → ilova
     → ilova downsampling qiladi
     → HTTPS batch (har 60 sek yoki 50 hodisa) → server
```

**Holat 2 — BLE ulangan, internet yo'q**
```
PT30 → ilova → lokal SQLite navbati
     → internet paydo bo'lganda → server
```

**Holat 3 — BLE uzilgan (telefon kabinada emas), dvigatel ishlayapti**
```
PT30 → o'z xotirasiga saqlaydi (har 30 daqiqa periodic + barcha transition)
     → telefon qaytganda BLE orqali stream + ACK
     → ilova serverga yuboradi, recordOrigin=4 (unidentified)
```

### 3.3. Umumiy sxema

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Web panel   │   │ Mobil ilova  │   │  Planshet    │
│  React/TS    │   │   Flutter    │   │   Flutter    │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │ REST + WS        │ REST + sync      │ (BLE ← PT30)
       └──────────────────┼──────────────────┘
                          │
                 ┌────────▼─────────┐
                 │   NestJS API     │  modulli monolit
                 └────────┬─────────┘
                          │
        ┌─────────────────┼─────────────────┐
   ┌────▼────┐      ┌─────▼─────┐    ┌──────▼──────┐
   │ Postgres│      │   Redis   │    │  S3 / MinIO │
   │  16     │      │cache+BullMQ│   │ fayl, rasm  │
   └─────────┘      └───────────┘    └─────────────┘
                          │
                    ┌─────▼─────┐
                    │  Workers  │  BullMQ (alohida konteyner)
                    └───────────┘
```

**API va Worker — bitta kod bazasi, ikki konteyner.** Og'ir ish API konteynerida bajarilmaydi.

### 3.4. NestJS modullari

```
src/
├── main.ts                  # API entrypoint
├── worker.ts                # Worker entrypoint
├── app.module.ts
│
├── common/
│   ├── decorators/          # @CurrentUser, @Perm, @Audit
│   ├── guards/              # JwtAuthGuard, PermissionGuard, DriverGuard
│   ├── interceptors/        # AuditInterceptor, TransformInterceptor
│   ├── filters/             # AllExceptionsFilter
│   ├── pipes/               # ZodValidationPipe
│   └── units/               # ⭐ metrik ↔ imperial konvertatsiya
│
├── core/
│   ├── prisma/              # PrismaService + BaseRepository
│   ├── config/              # env validation (zod)
│   ├── logger/              # pino
│   ├── queue/               # BullMQ
│   ├── storage/             # S3 adapter
│   ├── firebase/            # Firebase Admin SDK (Google Sign-In)
│   └── events/              # domain event bus
│
├── modules/
│   ├── auth/                # JWT, refresh, 2FA, Google Sign-In
│   ├── carrier/             # kompaniya profili — bitta qator
│   ├── users/               # back-office foydalanuvchilar
│   ├── roles/               # rollar va ruxsatlar
│   ├── drivers/             # drayverlar, CDL, istisnolar
│   ├── vehicles/            # unitlar, VIN, trailer, odometer offset
│   ├── devices/             # PT30 ro'yxati, pairing, firmware, BLE holati
│   ├── ingest/              # ⭐ ilovadan keladigan hodisa va telemetriya
│   ├── telemetry/           # Virtual Dashboard ma'lumotlari
│   ├── eld-events/          # §395 hodisalari (append-only)
│   ├── hos/                 # ⭐ qoidalar dvigateli
│   ├── logs/                # RODS, tuzatish, sertifikatlash
│   ├── unidentified/        # aniqlanmagan haydash
│   ├── dvir/                # ko'rik, defekt
│   ├── maintenance/         # ish buyurtmalari, xizmat jadvali
│   ├── trips/               # reyslar, dispetcherlik
│   ├── safety/              # harsh events, score, coaching
│   ├── reports/             # IFTA, FMCSA, Activity, DVIR
│   ├── transfers/           # eRODS / email uzatish
│   ├── messaging/           # chat, broadcast
│   ├── notifications/       # alert qoidalari, kanallar
│   ├── geofences/           # hududlar
│   ├── integrations/        # TMS, fuel card, webhook, API key
│   ├── audit/               # audit jurnali
│   ├── sync/                # mobil offline sinxronizatsiya
│   ├── support/             # tiket, feedback
│   └── realtime/            # WebSocket gateway
│
└── workers/
    ├── hos-recalc.processor.ts
    ├── report.processor.ts
    ├── transfer.processor.ts
    ├── alert.processor.ts
    ├── safety-detect.processor.ts
    └── retention.processor.ts
```

### 3.5. Qatlamlar

`*.controller.ts` → `*.service.ts` → `*.repository.ts`

- Controller biznes mantiq yozmaydi
- Repository HTTP bilmaydi
- **Barcha DB murojaatlari repository orqali.** Service'da `prisma.*` chaqirilmaydi

**Istisno:** `hos/` — sof funksiyalar, DB'ga murojaat qilmaydi, NestJS'ga bog'lanmagan.

---

## 4. Birliklar — metrik va imperial

### 4.1. Muammo

PT30 barcha qiymatlarni **metrik** tizimda beradi, AQSh esa **imperial** ishlatadi.

| Parametr | PT30 beradi | Bizga kerak |
|---|---|---|
| Tezlik | km/h | mph |
| Odometr | km | mile |
| Yoqilg'i | litr | gallon |
| Harorat | °C | °C (o'zgarmaydi) |
| Bosim | kPa | psi |
| Yoqilg'i sarfi | L/h | gal/h |
| Iqtisod | km/L | mpg |

### 4.2. Qoida

> **DB'da barcha masofa va hajm imperial saqlanadi** (mile, gallon, mph) — chunki FMCSA hisobotlari, IFTA va DOT fayli shu birliklarni talab qiladi.

Konvertatsiya **ilovada emas, backendda** bajariladi (`common/units/`), chunki:
- Ilova ikki xil (Flutter mobil + planshet) — mantiq takrorlanmasin
- Yaxlitlash xatolari bitta joyda nazorat qilinadi

```ts
// common/units/convert.ts
export const KM_TO_MI = 0.621371;
export const L_TO_GAL = 0.264172;

export const kmToMi   = (km: number) => Math.round(km * KM_TO_MI);
export const kmhToMph = (kmh: number) => Math.round(kmh * KM_TO_MI);
export const lToGal   = (l: number) => +(l * L_TO_GAL).toFixed(2);
export const kpaToPsi = (kpa: number) => +(kpa * 0.145038).toFixed(1);
```

**Muhim:** ingest payload'da qiymat **qanday kelgan bo'lsa shunday** (`raw*` maydonlarida) ham saqlanadi — audit va nosozliklarni tekshirish uchun.

### 4.3. Odometr masalasi ⚠️

Pacific Track hujjatiga ko'ra: **PT30 bergan odometr haqiqiy odometr bo'lmasligi mumkin.**

> "the dash value may report 23,100 miles and the PT30/PT40 may report 5,056"

Ya'ni qiymat **nisbiy** — o'sish tezligi to'g'ri, boshlang'ich nuqtasi boshqa. Pacific Track bu FMCSA talablariga mos ekanini tasdiqlagan.

**Backend yechimi:**

```prisma
model Vehicle {
  ...
  odometerMi       Int  @default(0)   // haqiqiy (dash) odometr — foydalanuvchi kiritadi
  deviceOdometerMi Int?               // PT30 bergan oxirgi qiymat
  odometerOffsetMi Int  @default(0)   // farq: odometerMi - deviceOdometerMi
  odometerCalibratedAt DateTime?
}
```

**Kalibrlash oqimi:**
1. Unit qo'shilganda foydalanuvchi paneldagi haqiqiy odometrni kiritadi
2. Birinchi PT30 hodisasi kelganda `odometerOffsetMi = odometerMi − deviceOdometerMi` hisoblanadi
3. Keyingi barcha hodisalarda: `true = device + offset`
4. Offset **vaqt o'tishi bilan sekin o'zgarishi mumkin** — panelda qayta kalibrlash tugmasi bo'ladi (`POST /vehicles/:id/calibrate-odometer`)

**Diagnostika:** agar `deviceOdometerMi` orqaga ketsa yoki bir kunda 2000 mile'dan ko'p sakrasa → `diagnostic 3` yoziladi va `alert.odometer_anomaly` chiqadi.

---

## 5. Ma'lumotlar modeli

### 5.1. Kompaniya profili — bitta qator

```prisma
model Carrier {
  id            String   @id @default("carrier")
  name          String
  dotNumber     String
  mcNumber      String?
  ein           String?
  timezone      String   @default("America/New_York")
  hosRuleset    HosRuleset @default(US_70_8_PROPERTY)
  distanceUnit  DistanceUnit @default(MILES)
  cycleRestart  Boolean  @default(true)
  unassignedThresholdMin Int @default(3)
  dvirRetentionMonths    Int @default(24)
  allowPersonalConveyance Boolean @default(true)
  allowYardMove           Boolean @default(true)
  addressLine1  String?
  city          String?
  state         String?
  zip           String?
  phone         String?
  complianceEmail String?
  logoUrl       String?

  // eRODS
  // Appendix A 7.15: ELD Identifier — aynan 6 belgili alfanumerik; 7.17: ELD Registration ID — aynan 4
  eldIdentifier     String @default("OBK001") @db.VarChar(6)
  eldRegistrationId String? @db.VarChar(4)
  erodsMode         ErodsMode @default(TEST)     // TEST | PRODUCTION

  updatedAt     DateTime @updatedAt
}

enum ErodsMode { TEST PRODUCTION }
```

```sql
ALTER TABLE "Carrier" ADD CONSTRAINT carrier_singleton CHECK (id = 'carrier');
ALTER TABLE "Carrier" ADD CONSTRAINT eld_identifier_format CHECK ("eldIdentifier" ~ '^[A-Z0-9]{6}$');
ALTER TABLE "Carrier" ADD CONSTRAINT eld_registration_id_format
  CHECK ("eldRegistrationId" IS NULL OR "eldRegistrationId" ~ '^[A-Z0-9]{4}$');
```

> **Diqqat (2026-10-08, B-138 — §395 ustun):** Appendix A 7.15 bo'yicha `eldIdentifier` — **aynan 6 belgi** `[A-Z0-9]` (ELD provayderi sertifikatlangan model/versiyaga beradi, masalan `1001ZE`); 7.17 bo'yicha `eldRegistrationId` — **aynan 4 belgi** `[A-Z0-9]` (FMCSA beradi, masalan `ZA10`). Avvalgi «ikkalasi ham 4 belgi, 6 belgili qiymat faylni yaroqsiz qiladi» qoidasi §395 ga zid edi. TEST rejimida `eldIdentifier = OBK001`; mavjud 4 belgili qiymatlar migratsiyada ko'chirildi (`OBK1` → `OBK001`, boshqalari oxiriga `00`; D-121). Figma va qo'llanmalardagi `#ONEB01` (6 belgi) identifikator sifatida to'g'ri shaklda.

### 5.2. Foydalanuvchilar va rollar

```prisma
model User {
  id            String   @id @default(uuid())
  email         String   @unique
  passwordHash  String?              // Google orqali kirsa null
  googleUid     String?  @unique     // Firebase UID
  authProvider  AuthProvider @default(PASSWORD)  // PASSWORD | GOOGLE
  firstName     String
  lastName      String
  jobTitle      String?
  phone         String?
  roleId        String
  status        UserStatus @default(INVITED)
  // twoFactorSecret/twoFactorEnabled/recoveryCodes removed 2026-09-13 (D-050, 2FA deleted)
  lastActiveAt  DateTime?
  invitedById   String?
  invitedAt     DateTime?
  createdAt     DateTime @default(now())

  role           Role      @relation(fields: [roleId], references: [id])
  sessions       Session[]
  managedDrivers Driver[]  @relation("DriverFleetManager")

  @@index([status])
}

model Role {
  id          String  @id @default(uuid())
  key         String  @unique
  name        String
  description String?
  isSystem    Boolean @default(false)
  permissions Json
  createdAt   DateTime @default(now())

  users       User[]
}

model Session {
  id          String   @id @default(uuid())
  userId      String
  refreshHash String
  userAgent   String?
  ip          String?
  deviceLabel String?
  lastSeenAt  DateTime @default(now())
  expiresAt   DateTime
  revokedAt   DateTime?
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, revokedAt])
}
```

### 5.3. Drayver va unit

```prisma
model Driver {
  id             String   @id @default(uuid())
  username       String   @unique
  passwordHash   String
  firstName      String
  lastName       String
  email          String?
  phone          String?
  cdlNumber      String
  cdlState       String
  status         DriverStatus @default(ACTIVE)

  // ⭐ RODS kuni AYNAN shu mintaqa bo'yicha bo'linadi (Carrier.timezone emas)
  homeTerminalName     String
  homeTerminalTimezone String   @default("America/New_York")

  hosRuleset     HosRuleset @default(US_70_8_PROPERTY)   // drayver darajasida ham o'zgarishi mumkin

  fleetManagerId    String?
  assignedVehicleId String?  @unique

  allowPersonalConveyance Boolean @default(false)
  allowYardMove           Boolean @default(false)
  adverseDrivingEnabled   Boolean @default(false)
  shortHaulException      Boolean @default(false)
  splitSleeperEnabled     Boolean @default(false)
  eldExempt               Boolean @default(false)
  eldExemptReason         String?

  appVersion   String?
  appPlatform  String?
  sdkVersion   String?          // Pacific Track SDK versiyasi
  lastSyncAt   DateTime?
  registeredAt DateTime @default(now())

  fleetManager    User?    @relation("DriverFleetManager", fields: [fleetManagerId], references: [id])
  assignedVehicle Vehicle? @relation("VehicleDriver", fields: [assignedVehicleId], references: [id])
  events          EldEvent[]
  dailyLogs       DailyLog[]
  violations      HosViolation[]
  pushTokens      PushToken[]
  dvirs           Dvir[]
  trips           Trip[]
  hosSnapshot     DriverHosSnapshot?
  pairingsAsPrimary CoDriverPairing[] @relation("PairingPrimary")
  pairingsAsCo      CoDriverPairing[] @relation("PairingCo")

  @@index([status])
}

// ⭐ Hamrox haydovchi — VAQT bilan chegaralangan munosabat, doimiy maydon emas.
// Team driving bir reys davomida bo'ladi va tarixi saqlanishi shart:
// "kim, qachondan qachongacha, qaysi unitda hamrox edi".
model CoDriverPairing {
  id            String   @id @default(uuid())
  primaryDriverId String
  coDriverId      String
  vehicleId       String
  startedAt     DateTime
  endedAt       DateTime?
  startedById   String?           // kim boshladi (drayver yoki dispetcher)
  endedById     String?

  primaryDriver Driver  @relation("PairingPrimary", fields: [primaryDriverId], references: [id])
  coDriver      Driver  @relation("PairingCo",      fields: [coDriverId],      references: [id])
  vehicle       Vehicle @relation(fields: [vehicleId], references: [id])

  @@index([primaryDriverId, startedAt])
  @@index([coDriverId, startedAt])
  @@index([vehicleId, startedAt])
}

// ⭐ Push token — bitta drayverda telefon VA planshet bo'lishi mumkin
model PushToken {
  id         String   @id @default(uuid())
  driverId   String
  token      String   @unique
  platform   AppPlatform            // IOS | ANDROID
  deviceLabel String?
  lastSeenAt DateTime @default(now())
  createdAt  DateTime @default(now())

  driver     Driver @relation(fields: [driverId], references: [id], onDelete: Cascade)

  @@index([driverId])
}

enum AppPlatform { IOS ANDROID }

model Vehicle {
  id           String  @id @default(uuid())
  unitNumber   String  @unique
  vin          String  @unique
  make         String?
  model        String?
  year         Int?
  licensePlate String?
  plateState   String?
  fuelType     FuelType @default(DIESEL)
  sleeperBerth Boolean  @default(false)

  odometerMi           Int      @default(0)
  deviceOdometerMi     Int?
  odometerOffsetMi     Int      @default(0)
  odometerCalibratedAt DateTime?
  engineHours          Decimal  @db.Decimal(10,2) @default(0)

  busType      BusType?         // J1939 | J1708 | OBD_II
  status       VehicleStatus @default(ACTIVE)
  notes        String?
  activatedAt  DateTime?
  createdAt    DateTime @default(now())

  // Qurilma ↔ unit bog'lanishi FAQAT bitta joyda — Device.vehicleId da.
  // Ilgari ikkala tomonda ham saqlanardi, bu desinxronlashuvga olib kelardi.
  device       Device?
  driver       Driver?  @relation("VehicleDriver")
  events       EldEvent[]
  pairings     CoDriverPairing[]
  dvirs        Dvir[]
  defects      Defect[]
  workOrders   WorkOrder[]
  schedules    MaintenanceSchedule[]
  trips        Trip[]

  @@index([status])
}

model Trailer {
  id     String @id @default(uuid())
  number String @unique
  vin    String?
  status VehicleStatus @default(ACTIVE)

  dvirs  Dvir[]
}
```

### 5.4. PT30 qurilmasi

```prisma
model Device {
  id            String   @id @default(uuid())
  serial        String   @unique          // "PT30_A86E"
  bleMacAddress String?  @unique
  model         DeviceModel               // PT30 | PT40
  firmware      String?                   // "L113"
  vehicleId     String?
  status        DeviceStatus @default(UNASSIGNED)

  // BLE holati — ilova xabar beradi
  bleState      BleState  @default(DISCONNECTED)  // CONNECTED | OUT_OF_RANGE | DISCONNECTED
  lastSeenAt    DateTime?                 // oxirgi BLE aloqasi
  lastEventAt   DateTime?                 // oxirgi hodisa kelgan vaqt
  storedEventsCount Int @default(0)       // qurilmada kutayotgan hodisalar

  // PT30 sozlamalari (hujjatdagi o'zgaruvchilar)
  periodicConnectedSec    Int @default(30)   // PE — 2..7200
  periodicDisconnectedMin Int @default(30)   // PN — 1..480

  pairedAt      DateTime?
  createdAt     DateTime @default(now())

  vehicle       Vehicle? @relation(fields: [vehicleId], references: [id])
  events        EldEvent[]

  @@unique([vehicleId])          // bitta unitda bitta qurilma
  @@index([status])
  @@index([bleState, lastSeenAt])
}

enum DeviceModel { PT30 PT40 }
enum BleState { CONNECTED OUT_OF_RANGE DISCONNECTED }
enum BusType { J1939 J1708 OBD_II }
```

**Firmware talabi:** Virtual Dashboard uchun PT30 ≥ **L108** (tavsiya **L113**), SDK Android ≥ 6.7.1 / iOS ≥ 6.7.0, **unified SDK**. Bundan past bo'lsa panelda ogohlantirish chiqadi.

### 5.5. ELD hodisalari — append-only yadro

> **Bu jadval hech qachon `UPDATE` yoki `DELETE` qilinmaydi.**

```prisma
model EldEvent {
  id            BigInt   @id @default(autoincrement())
  uuid          String   @unique          // ilovadan keladi — idempotentlik
  driverId      String?
  vehicleId     String?
  deviceId      String?

  // §395 Appendix A majburiy maydonlari
  eventType     Int                  // 1..7
  eventCode     Int
  eventSequenceId Int                // ⭐ Appendix A: 1..65535, drayver bo'yicha monoton, output faylda majburiy
  eventDateTime DateTime             // UTC — qurilma vaqti
  timezoneOffset Int                 // daqiqada
  recordStatus  Int      @default(1) // 1=active 2=inactive-changed 3=change requested 4=change rejected
  recordOrigin  Int                  // 1=ELD auto 2=driver 3=other user 4=unidentified

  // ⭐ Joylashuv AYNAN saqlanadigan aniqlikda yoziladi (7.3, qoida 9):
  //    on-duty/driving → 1 milya · PC → 10 milya. Qo'pollashtirish ingest'da bajariladi,
  //    xom koordinata hech qayerda saqlanmaydi.
  latitude      Decimal? @db.Decimal(9,6)
  longitude     Decimal? @db.Decimal(9,6)
  locationPrecisionMi Int  @default(1)   // 1 | 10
  locationName  String?
  locationSource Int?
  distanceSinceLastValidCoords Int?

  totalVehicleMiles Int?             // offset qo'llangan (haqiqiy)
  rawDeviceOdometerKm Int?           // PT30 bergan xom qiymat
  totalEngineHours  Decimal? @db.Decimal(10,2)

  malfunctionCode String?            // P E T L R S O
  diagnosticCode  String?            // 1..6

  annotation    String?  @db.VarChar(60)
  comment       String?
  supersedesId  BigInt?
  editedById    String?
  editorType    EditorType?
  editReason    String?

  // gateway metadata
  wasStoredOnDevice Boolean @default(false)  // BLE uzilganda saqlangan
  receivedAt    DateTime @default(now())     // serverga kelgan vaqt
  uploadedByDriverId String?                 // qaysi ilova yubordi

  checksum      String
  createdAt     DateTime @default(now())

  driver        Driver?  @relation(fields: [driverId],  references: [id])
  vehicle       Vehicle? @relation(fields: [vehicleId], references: [id])
  device        Device?  @relation(fields: [deviceId],  references: [id])

  @@unique([driverId, eventSequenceId])
  @@index([driverId, eventDateTime])
  @@index([vehicleId, eventDateTime])
  @@index([recordStatus, eventDateTime])
}
```

**Hodisa turlari:**

| Type | Nomi | Kodlar |
|---|---|---|
| 1 | Duty status change | 1=OFF, 2=SB, 3=D, 4=ON |
| 2 | Intermediate log | 1=konventsional, 2=kamaytirilgan aniqlik |
| 3 | PC / YM ko'rsatkichi | 1=PC, 2=YM, 0=tozalandi |
| 4 | Driver certification | 1=birinchi, 2..9=qayta |
| 5 | Login / logout | 1=login, 2=logout |
| 6 | Engine power | 1=power up, 2=power up (kam), 3=shutdown, 4=shutdown (kam) |
| 7 | Malfunction / diagnostic | 1=logged, 2=cleared, 3=diag logged, 4=diag cleared |

**Malfunction:** `P` power · `E` engine sync · `T` timing · `L` positioning · `R` data recording · `S` data transfer · `O` other
**Diagnostic:** `1` power data · `2` engine sync · `3` missing data · `4` data transfer · `5` unidentified driving · `6` other

#### Event Sequence ID

Appendix A output faylining Event list segmenti har bir hodisa uchun **Event Sequence ID Number** talab qiladi — `1..65535` (hex `0001..FFFF`), drayver bo'yicha monoton o'suvchi, `FFFF` dan keyin `0001` ga qaytadi.

- Raqam **ingest paytida, bir marta** beriladi va hech qachon o'zgarmaydi
- Berish `driverId` bo'yicha ketma-ket (Postgres advisory lock yoki drayver bo'yicha sequence)
- Tuzatish hodisasi (`recordStatus=3`) ham **yangi** sequence oladi
- Aynan shu sabab output fayl qayta generatsiya qilinganda raqamlar o'zgarmaydi

> Ilgari bu maydon modelda yo'q edi va fayl generatsiya paytida "yo'qdan" yasalardi — qayta generatsiyada raqamlar siljib ketardi va inspektor ikki xil fayl olardi.

#### Partition va saqlash

`EldEvent` ham `TelemetryPoint` kabi **oylik partition** qilinadi (`eventDateTime` bo'yicha).

| Ma'lumot | Saqlash | Sabab |
|---|---|---|
| `EldEvent` | **minimum 6 oy issiq + 24 oy arxiv** | FMCSA RODS 6 oy; audit va nizolar uchun 24 oy |
| 24 oydan eski partition | sovuq saqlashga (S3 `pg_dump` bo'lagi), keyin `DETACH` | jadval o'lchamini ushlab turish |

`retention.processor` partitionlarni avtomatik yaratadi. **`DROP` qilishdan oldin arxiv nusxasi tasdiqlanadi** — hodisa yo'qolishi muvofiqlikni buzadi.

### 5.6. Telemetriya (Virtual Dashboard)

PT30 ning Virtual Dashboard to'plami — hujjatdagi barcha parametrlar.

```prisma
model TelemetryPoint {
  time        DateTime
  vehicleId   String
  driverId    String?

  latitude    Decimal  @db.Decimal(9,6)
  longitude   Decimal  @db.Decimal(9,6)
  speedMph    Int?
  headingDeg  Int?

  odometerMi  Int?             // offset qo'llangan
  engineHours Decimal? @db.Decimal(10,2)
  idleHours   Decimal? @db.Decimal(10,2)
  ptoHours    Decimal? @db.Decimal(10,2)

  engineOn    Boolean?
  rpm         Int?
  gear        String?
  seatBelt    Boolean?
  loadPct     Int?

  fuelPct     Int?             // tank 1
  fuelPct2    Int?             // tank 2
  defPct      Int?
  fuelRateGph Decimal? @db.Decimal(6,2)
  fuelEconomyMpg Decimal? @db.Decimal(5,2)
  totalFuelUsedGal Decimal? @db.Decimal(10,2)
  totalFuelIdleGal Decimal? @db.Decimal(10,2)

  oilPressurePsi Decimal? @db.Decimal(6,1)
  oilPct         Int?
  oilTempC       Int?
  coolantPct     Int?
  coolantTempC   Int?
  intakeTempC    Int?
  ambientTempC   Int?
  transmOilTempC Int?

  dtcCount    Int?
  busType     BusType?
  voltage     Decimal? @db.Decimal(4,1)

  @@id([time, vehicleId])
  @@index([vehicleId, time])
}
```

> **Eslatma (hujjatdan):** hamma parametr hamma yuk mashinasida mavjud emas. Yo'q parametr `null` bo'ladi — bu xato emas. SDK qaysi parametr yangilanganini aytadi.

**Partition:** oylik, `retention.processor` avtomatik yaratadi va **13 oydan** eskisini `DROP` qiladi.

### 5.7. Nosozlik kodlari (DTC)

```prisma
model DiagnosticTroubleCode {
  id         String   @id @default(uuid())
  vehicleId  String
  spn        Int?              // Suspect Parameter Number (J1939)
  fmi        Int?              // Failure Mode Identifier
  occurrence Int      @default(1)
  source     String?           // ECU manzili
  description String?
  firstSeenAt DateTime
  lastSeenAt  DateTime
  clearedAt   DateTime?

  @@index([vehicleId, clearedAt])
}
```

Dekodlash jadvali `eld.docs/pt30_docs/Decoding DTC.pdf` asosida `devices/dtc-codes.ts` da seed qilinadi.

### 5.8. Kunlik jurnal va buzilishlar

```prisma
model DailyLog {
  id            String   @id @default(uuid())
  driverId      String
  logDate       DateTime @db.Date        // kun chegarasi — driver.homeTerminalTimezone bo'yicha
  timezone      String                   // o'sha paytdagi homeTerminalTimezone nusxasi (tarixiy)

  offDutySec    Int      @default(0)
  sleeperSec    Int      @default(0)
  drivingSec    Int      @default(0)
  onDutySec     Int      @default(0)
  totalDistanceMi Int    @default(0)

  certified     Boolean  @default(false)
  certifiedAt   DateTime?
  certifiedById String?
  certifierType EditorType?
  certificationCount Int @default(0)
  signatureUrl  String?

  hasViolation   Boolean @default(false)
  violationCount Int     @default(0)
  hasUnassigned  Boolean @default(false)
  hasEdits       Boolean @default(false)

  recalcVersion  Int      @default(1)
  recalculatedAt DateTime?

  driver        Driver @relation(fields: [driverId], references: [id])
  violations    HosViolation[]

  @@unique([driverId, logDate])
  @@index([logDate])
  @@index([certified, logDate])
}

model HosViolation {
  id            String   @id @default(uuid())
  driverId      String
  dailyLogId    String?
  logDate       DateTime @db.Date       // ⭐ barqaror kalit qismi
  type          ViolationType
  occurredAt    DateTime                // aniq vaqt — recalc'da o'zgarishi mumkin
  exceededBySec Int
  detail        String
  status        ViolationStatus @default(OPEN)
  recalcVersion Int      @default(1)
  resolvedAt    DateTime?
  resolvedById  String?
  resolutionNote String?

  driver        Driver    @relation(fields: [driverId],   references: [id])
  dailyLog      DailyLog? @relation(fields: [dailyLogId], references: [id])

  // Kalitda occurredAt YO'Q: qayta hisoblashda vaqt bir necha sekundga siljishi mumkin,
  // bu esa har recalc'da yangi qator yaratib, eskisini OPEN holida qoldirardi.
  @@unique([driverId, logDate, type])
  @@index([status, occurredAt])
}
```

### 5.9. Aniqlanmagan haydash

```prisma
model UnidentifiedSegment {
  id            String   @id @default(uuid())
  vehicleId     String
  startAt       DateTime
  endAt         DateTime
  durationSec   Int
  distanceMi    Int
  startLocation String?
  endLocation   String?
  status        UnidentifiedStatus @default(PENDING)
  assignedDriverId String?
  assignedById  String?
  assignedAt    DateTime?
  annotation    String?  @db.VarChar(60)
  eventIds      BigInt[]
  fromStoredEvents Boolean @default(false)  // true — qurilma xotirasidan kelgan (BLE uzilgan payt)
                                            // false — jonli yozilgan (dvigatel ishlagan, hech kim login qilmagan)

  @@index([status, startAt])
  @@index([vehicleId, startAt])
}
```

### 5.10. DVIR, xizmat, reys va qolgan modellar

> Ilgari bu bo'lim «tuzilmalar v2.0 dagidek qoladi» deb qoldirilgan edi. Lekin bu TZ **yagona haqiqat manbai** — v2.0 hujjati mavjud emas. Quyida barcha qolgan modellar to'liq yozilgan.

#### DVIR va texnik xizmat

```prisma
model Dvir {
  id            String   @id @default(uuid())
  driverId      String
  vehicleId     String
  trailerId     String?
  type          DvirType                    // PRE_TRIP | POST_TRIP | INTERMEDIATE
  submittedAt   DateTime
  odometerMi    Int
  latitude      Decimal? @db.Decimal(9,6)
  longitude     Decimal? @db.Decimal(9,6)
  locationName  String?
  vehicleCondition DvirCondition            // SATISFACTORY | DEFECTS_FOUND
  driverSignatureUrl String
  notes         String?  @db.VarChar(500)

  // mexanik tomoni
  mechanicName      String?
  mechanicSignedAt  DateTime?
  mechanicNote      String?
  repairStatus      RepairStatus @default(NOT_REQUIRED)  // NOT_REQUIRED | PENDING | REPAIRED | DEFERRED
  nextDriverReviewedAt DateTime?             // keyingi drayver ko'rib chiqdi (§396.13)

  createdAt     DateTime @default(now())

  driver   Driver   @relation(fields: [driverId],  references: [id])
  vehicle  Vehicle  @relation(fields: [vehicleId], references: [id])
  trailer  Trailer? @relation(fields: [trailerId], references: [id])
  defects  Defect[]
  photos   Attachment[]

  @@index([vehicleId, submittedAt])
  @@index([driverId, submittedAt])
  @@index([repairStatus])
}

model Defect {
  id          String   @id @default(uuid())
  dvirId      String
  vehicleId   String
  category    String                        // "Brakes, Service", "Lights (Head - Stop)" ...
  part        DefectPart                    // TRUCK | TRAILER
  severity    DefectSeverity                // MINOR | MAJOR | CRITICAL
  description String   @db.VarChar(500)
  status      DefectStatus @default(OPEN)   // OPEN | IN_PROGRESS | REPAIRED | DEFERRED
  outOfService Boolean @default(false)      // CRITICAL → true, unit yo'lga chiqmaydi
  workOrderId String?
  resolvedAt  DateTime?
  resolvedById String?
  resolutionNote String?
  createdAt   DateTime @default(now())

  dvir      Dvir       @relation(fields: [dvirId], references: [id], onDelete: Cascade)
  vehicle   Vehicle    @relation(fields: [vehicleId], references: [id])
  workOrder WorkOrder? @relation(fields: [workOrderId], references: [id])
  photos    Attachment[]

  @@index([vehicleId, status])
  @@index([status, severity])
}
```

> **Out-of-service qoidasi:** `severity = CRITICAL` bo'lgan ochiq defekt bo'lsa `Vehicle.status = OUT_OF_SERVICE` ga o'tadi va unitga drayver biriktirib bo'lmaydi. Defekt yopilganda status avtomatik tiklanadi. Aynan shu qoida Figmada `#110` ni yo'ldan chiqargan, `#101` ni esa ishlashda qoldirgan.

```prisma
model WorkOrder {
  id          String   @id @default(uuid())
  number      String   @unique             // "WO-2214"
  vehicleId   String
  title       String
  description String?
  priority    WorkOrderPriority @default(NORMAL)
  status      WorkOrderStatus   @default(OPEN)   // OPEN | IN_PROGRESS | DONE | CANCELLED
  vendor      String?
  costUsd     Decimal? @db.Decimal(10,2)
  odometerMi  Int?
  openedById  String
  openedAt    DateTime @default(now())
  dueAt       DateTime?
  closedAt    DateTime?

  vehicle Vehicle  @relation(fields: [vehicleId], references: [id])
  defects Defect[]

  @@index([status, dueAt])
  @@index([vehicleId, status])
}

model MaintenanceSchedule {
  id            String   @id @default(uuid())
  vehicleId     String
  name          String                       // "Brake service", "DOT annual inspection"
  intervalMi    Int?
  intervalDays  Int?
  lastServiceMi Int?
  lastServiceAt DateTime?
  nextDueMi     Int?
  nextDueAt     DateTime?
  enabled       Boolean  @default(true)

  vehicle Vehicle @relation(fields: [vehicleId], references: [id])

  @@index([vehicleId, enabled])
  @@index([nextDueAt])
}
```

#### Reys va dispetcherlik

```prisma
model Trip {
  id           String   @id @default(uuid())
  number       String   @unique              // "TR-4821"
  driverId     String?
  vehicleId    String?
  trailerId    String?
  status       TripStatus @default(PLANNED)  // PLANNED | ASSIGNED | IN_PROGRESS | DELIVERED | CANCELLED
  shippingDocument String?                   // "BOL #4821-A"
  commodity    String?
  weightLbs    Int?
  pieces       Int?
  plannedStartAt DateTime?
  plannedEndAt   DateTime?
  startedAt    DateTime?
  completedAt  DateTime?
  etaAt        DateTime?
  onTime       Boolean?
  notes        String?  @db.VarChar(500)
  createdById  String
  createdAt    DateTime @default(now())

  driver  Driver?  @relation(fields: [driverId],  references: [id])
  vehicle Vehicle? @relation(fields: [vehicleId], references: [id])
  stops   TripStop[]

  @@index([status, plannedStartAt])
  @@index([driverId, status])
}

model TripStop {
  id          String   @id @default(uuid())
  tripId      String
  sequence    Int
  type        StopType                       // PICKUP | DELIVERY | FUEL | REST | CHECKPOINT
  name        String
  address     String?
  latitude    Decimal? @db.Decimal(9,6)
  longitude   Decimal? @db.Decimal(9,6)
  scheduledAt DateTime?
  arrivedAt   DateTime?
  departedAt  DateTime?
  status      StopStatus @default(PENDING)   // PENDING | ARRIVED | COMPLETED | SKIPPED
  note        String?

  trip Trip @relation(fields: [tripId], references: [id], onDelete: Cascade)

  @@unique([tripId, sequence])
}

model Geofence {
  id        String   @id @default(uuid())
  name      String
  type      GeofenceType @default(CIRCLE)    // CIRCLE | POLYGON
  centerLat Decimal? @db.Decimal(9,6)
  centerLon Decimal? @db.Decimal(9,6)
  radiusMi  Decimal? @db.Decimal(6,2)
  polygon   Json?                            // [[lat,lon], ...]
  category  String?                          // terminal, shipper, yard
  alertOnEnter Boolean @default(false)
  alertOnExit  Boolean @default(false)
  enabled   Boolean  @default(true)
  createdAt DateTime @default(now())
}
```

#### Xavfsizlik

```prisma
model SafetyEvent {
  id          String   @id @default(uuid())
  driverId    String?
  vehicleId   String
  type        SafetyEventType                // HARSH_BRAKING | HARSH_ACCEL | HARSH_TURN | SPEEDING | SEATBELT
  occurredAt  DateTime
  severity    Int                            // 1..5
  speedMph    Int?
  speedLimitMph Int?
  gForce      Decimal? @db.Decimal(4,2)
  latitude    Decimal? @db.Decimal(9,6)
  longitude   Decimal? @db.Decimal(9,6)
  locationName String?
  durationSec Int?
  status      CoachingStatus @default(NEW)   // NEW | REVIEWED | COACHED | DISMISSED
  coachedById String?
  coachedAt   DateTime?
  coachingNote String?

  @@index([driverId, occurredAt])
  @@index([vehicleId, occurredAt])
  @@index([status, occurredAt])
}

model DriverScore {
  id            String   @id @default(uuid())
  driverId      String
  periodStart   DateTime @db.Date
  periodEnd     DateTime @db.Date
  score         Int                          // 0..100
  harshCount    Int      @default(0)
  speedingCount Int      @default(0)
  milesDriven   Int      @default(0)
  violationCount Int     @default(0)
  rank          Int?

  @@unique([driverId, periodStart])
}
```

#### Xabar almashish

```prisma
model Conversation {
  id           String   @id @default(uuid())
  type         ConversationType @default(DIRECT)  // DIRECT | GROUP | BROADCAST
  title        String?
  lastMessageAt DateTime?
  createdById  String
  createdAt    DateTime @default(now())

  participants ConversationParticipant[]
  messages     Message[]

  @@index([lastMessageAt])
}

model ConversationParticipant {
  id             String   @id @default(uuid())
  conversationId String
  userId         String?
  driverId       String?
  lastReadAt     DateTime?
  mutedUntil     DateTime?

  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@unique([conversationId, userId, driverId])
}

model Message {
  id             String   @id @default(uuid())
  conversationId String
  senderUserId   String?
  senderDriverId String?
  body           String   @db.VarChar(2000)
  attachmentId   String?
  clientId       String?  @unique          // offline navbatdan kelgan ID — idempotentlik
  sentAt         DateTime @default(now())
  deliveredAt    DateTime?
  readAt         DateTime?

  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId, sentAt])
}
```

#### Bildirishnomalar

```prisma
model AlertRule {
  id         String   @id @default(uuid())
  key        String   @unique               // "hos_violation", "eld_disconnected" ...
  name       String
  severity   AlertSeverity                  // CRITICAL | WARNING | INFO
  conditions Json                           // Condition[] — 14-bo'lim
  channels   String[]                       // IN_APP | EMAIL | WEBHOOK
  recipients Json                           // RecipientSelector
  throttle   Json?                          // { perDriverPerDay, cooldownMin }
  quietHours Json?                          // { from, to, timezone }
  enabled    Boolean  @default(true)
  isSystem   Boolean  @default(false)
  createdAt  DateTime @default(now())

  deliveries AlertDelivery[]
}

model AlertDelivery {
  id          String   @id @default(uuid())
  alertRuleId String
  channel     String
  recipient   String                        // email yoki userId yoki webhook URL
  subjectType String?                       // Driver | Vehicle | Device
  subjectId   String?
  payload     Json
  status      DeliveryStatus @default(QUEUED)  // QUEUED | SENT | FAILED | SUPPRESSED
  attempts    Int      @default(0)
  error       String?
  sentAt      DateTime?
  createdAt   DateTime @default(now())

  alertRule AlertRule @relation(fields: [alertRuleId], references: [id])

  @@index([status, createdAt])
  @@index([subjectType, subjectId])
}

model Notification {
  id         String   @id @default(uuid())
  userId     String?
  driverId   String?
  type       String
  title      String
  body       String
  objectType String?
  objectId   String?
  readAt     DateTime?
  createdAt  DateTime @default(now())

  @@index([userId, readAt])
  @@index([driverId, readAt])
}
```

#### Hisobot va uzatish

```prisma
model Report {
  id          String   @id @default(uuid())
  type        ReportType                    // IFTA | ACTIVITY | DVIR | FMCSA_PACK | UNIDENTIFIED | SAFETY
  format      ReportFormat                  // PDF | CSV | XLSX
  params      Json                          // { from, to, driverIds, vehicleIds, quarter ... }
  status      ReportStatus @default(QUEUED) // QUEUED | RUNNING | READY | FAILED
  fileKey     String?
  fileSizeBytes Int?
  rowCount    Int?
  error       String?
  requestedById String
  requestedAt DateTime @default(now())
  completedAt DateTime?
  expiresAt   DateTime?                     // S3'da 24 oy

  @@index([requestedById, requestedAt])
  @@index([status])
}

model ReportSchedule {
  id         String   @id @default(uuid())
  reportType ReportType
  format     ReportFormat
  params     Json
  cron       String                         // "0 6 * * 1"
  timezone   String
  recipients String[]                       // email
  enabled    Boolean  @default(true)
  lastRunAt  DateTime?
  nextRunAt  DateTime?
  createdById String
}

model DataTransfer {
  id            String   @id @default(uuid())
  driverId      String
  method        TransferMethod               // WEB_SERVICES | EMAIL
  rangeStart    DateTime @db.Date
  rangeEnd      DateTime @db.Date
  outputFileComment String @db.VarChar(60)
  fileName      String
  fileKey       String
  fileSizeBytes Int
  checksum      String
  encrypted     Boolean @default(false)      // email uzatishda majburiy — 10.4
  status        TransferStatus @default(QUEUED)
                // QUEUED | TEST_ONLY | SENT | ACCEPTED | REJECTED | FAILED
  erodsMode     ErodsMode
  referenceId   String?                      // "ERODS-TEST-25-0910-4821"
  responseCode  String?
  responseBody  String?
  attempts      Int      @default(0)
  requestedById String?
  requestedByType EditorType
  createdAt     DateTime @default(now())
  sentAt        DateTime?

  @@index([driverId, createdAt])
  @@index([status])
}
```

#### IFTA va yoqilg'i

```prisma
model IftaSegment {
  id          String   @id @default(uuid())
  vehicleId   String
  driverId    String?
  jurisdiction String                        // "OH", "KY", "ON"
  date        DateTime @db.Date
  distanceMi  Int
  tollMi      Int      @default(0)
  fuelGal     Decimal  @db.Decimal(10,2) @default(0)
  createdAt   DateTime @default(now())

  @@unique([vehicleId, jurisdiction, date])
  @@index([date])
}

model FuelPurchase {
  id          String   @id @default(uuid())
  vehicleId   String
  driverId    String?
  purchasedAt DateTime
  jurisdiction String
  gallons     Decimal  @db.Decimal(8,2)
  pricePerGal Decimal  @db.Decimal(6,3)
  totalUsd    Decimal  @db.Decimal(10,2)
  vendor      String?
  receiptId   String?                        // Attachment
  source      String?                        // "WEX", "manual"
  externalId  String?  @unique
  odometerMi  Int?

  @@index([vehicleId, purchasedAt])
}
```

> **Saqlash muddati:** `IftaSegment` va `FuelPurchase` — **4 yil** (IFTA audit talabi). Telemetriya 13 oydan keyin o'chirilgani uchun segmentlarni telemetriyadan qayta hisoblab bo'lmaydi — ular hisoblangach mustaqil yashaydi.

#### Integratsiya va tizim

```prisma
model Integration {
  id          String   @id @default(uuid())
  provider    String   @unique              // "mcleod", "wex", "quickbooks", "slack"
  enabled     Boolean  @default(false)
  config      Json                          // sirlar shifrlanadi
  status      IntegrationStatus @default(DISCONNECTED)
  lastSyncAt  DateTime?
  lastError   String?
  createdAt   DateTime @default(now())
}

model ApiKey {
  id         String   @id @default(uuid())
  name       String
  keyHash    String   @unique               // SHA-256
  prefix     String                         // ko'rsatish uchun: "obk_live_a3f9…"
  scopes     String[]
  createdById String
  lastUsedAt DateTime?
  expiresAt  DateTime?
  revokedAt  DateTime?
  createdAt  DateTime @default(now())
}

model WebhookDelivery {
  id         String   @id @default(uuid())
  integrationId String?
  url        String
  eventType  String
  payload    Json
  signature  String
  status     DeliveryStatus @default(QUEUED)
  attempts   Int      @default(0)
  httpStatus Int?
  responseBody String?
  nextRetryAt DateTime?
  createdAt  DateTime @default(now())

  @@index([status, nextRetryAt])
}

model Attachment {
  id         String   @id @default(uuid())
  key        String   @unique               // S3 kaliti
  mimeType   String
  sizeBytes  Int
  width      Int?
  height     Int?

  // Polimorf bog'lanish Prisma'da bitta ustun bilan ishlamaydi —
  // har bir egasi uchun alohida nullable FK.
  dvirId         String?
  defectId       String?
  messageId      String?
  fuelPurchaseId String?

  uploadedById   String?
  uploadedByType EditorType
  createdAt      DateTime @default(now())

  dvir   Dvir?   @relation(fields: [dvirId],   references: [id], onDelete: Cascade)
  defect Defect? @relation(fields: [defectId], references: [id], onDelete: Cascade)

  @@index([dvirId])
  @@index([defectId])
}

model SupportTicket {
  id          String   @id @default(uuid())
  number      String   @unique              // "#122229"
  subject     String
  body        String
  category    String?
  priority    TicketPriority @default(NORMAL)
  status      TicketStatus   @default(OPEN)  // OPEN | IN_PROGRESS | RESOLVED | CLOSED
  createdByUserId   String?
  createdByDriverId String?
  assignedToId String?
  createdAt   DateTime @default(now())
  resolvedAt  DateTime?
}

model Feedback {
  id         String   @id @default(uuid())
  driverId   String?
  userId     String?
  answers    Json                           // savol → javob
  comment    String?  @db.VarChar(1000)
  appVersion String?
  platform   String?
  createdAt  DateTime @default(now())
}
```

```prisma
// 8.6, 5-band: ilova hisoblagan oxirgi HOS holati — server bilan solishtirish uchun
model DriverHosSnapshot {
  driverId         String   @id
  computedAt       DateTime
  receivedAt       DateTime @default(now())
  hosEngineVersion String
  appPlatform      AppPlatform?
  state            Json                     // HosState

  // tungi solishtiruv natijasi
  lastComparedAt   DateTime?
  maxDriftSec      Int?
  driftAlerted     Boolean  @default(false)

  driver Driver @relation(fields: [driverId], references: [id], onDelete: Cascade)
}
```

`AuditLog` — 18-bo'limda.

> **Relation qoidasi:** Prisma har bir relationning **ikkala tomonini** talab qiladi. Yuqoridagi modellarda teskari maydonlar (`Vehicle.dvirs`, `Driver.trips`, `Role.users` va h.k.) shu sabab yozilgan. Oldingi versiyada ular yo'q edi va sxema `prisma validate` dan o'tmasdi.

### 5.11. Enumlar

```prisma
enum HosRuleset      { US_70_8_PROPERTY US_60_7_PROPERTY US_70_8_PASSENGER US_60_7_PASSENGER }
enum DistanceUnit    { MILES KILOMETERS }
enum ErodsMode       { TEST PRODUCTION }
enum AuthProvider    { PASSWORD GOOGLE }
enum UserStatus      { INVITED ACTIVE DISABLED }
enum DriverStatus    { ACTIVE INACTIVE TERMINATED }
enum VehicleStatus   { ACTIVE INACTIVE OUT_OF_SERVICE }
enum DeviceStatus    { UNASSIGNED ASSIGNED FAULTY RETIRED }
enum DeviceModel     { PT30 PT40 }
enum BleState        { CONNECTED OUT_OF_RANGE DISCONNECTED }
enum BusType         { J1939 J1708 OBD_II }
enum FuelType        { DIESEL GASOLINE CNG LNG ELECTRIC }
enum AppPlatform     { IOS ANDROID }
enum EditorType      { DRIVER USER SYSTEM }
enum DutyStatus      { OFF SB D ON }
enum ViolationType   { DRIVING_11 SHIFT_14 BREAK_30 CYCLE_70 CYCLE_60 FORM_MANNER }
enum ViolationStatus { OPEN RESOLVED AUTO_CLEARED }
enum UnidentifiedStatus { PENDING ASSIGNED REJECTED ANNOTATED }
enum DvirType        { PRE_TRIP POST_TRIP INTERMEDIATE }
enum DvirCondition   { SATISFACTORY DEFECTS_FOUND }
enum RepairStatus    { NOT_REQUIRED PENDING REPAIRED DEFERRED }
enum DefectPart      { TRUCK TRAILER }
enum DefectSeverity  { MINOR MAJOR CRITICAL }
enum DefectStatus    { OPEN IN_PROGRESS REPAIRED DEFERRED }
enum WorkOrderPriority { LOW NORMAL HIGH URGENT }
enum WorkOrderStatus { OPEN IN_PROGRESS DONE CANCELLED }
enum TripStatus      { PLANNED ASSIGNED IN_PROGRESS DELIVERED CANCELLED }
enum StopType        { PICKUP DELIVERY FUEL REST CHECKPOINT }
enum StopStatus      { PENDING ARRIVED COMPLETED SKIPPED }
enum GeofenceType    { CIRCLE POLYGON }
enum SafetyEventType { HARSH_BRAKING HARSH_ACCEL HARSH_TURN SPEEDING SEATBELT }
enum CoachingStatus  { NEW REVIEWED COACHED DISMISSED }
enum ConversationType { DIRECT GROUP BROADCAST }
enum AlertSeverity   { CRITICAL WARNING INFO }
enum DeliveryStatus  { QUEUED SENT FAILED SUPPRESSED }
enum ReportType      { IFTA ACTIVITY DVIR FMCSA_PACK UNIDENTIFIED SAFETY }
enum ReportFormat    { PDF CSV XLSX }
enum ReportStatus    { QUEUED RUNNING READY FAILED }
enum TransferMethod  { WEB_SERVICES EMAIL }
enum TransferStatus  { QUEUED TEST_ONLY SENT ACCEPTED REJECTED FAILED }
enum IntegrationStatus { DISCONNECTED CONNECTED ERROR }
enum TicketPriority  { LOW NORMAL HIGH URGENT }
enum TicketStatus    { OPEN IN_PROGRESS RESOLVED CLOSED }
```

---

## 6. Autentifikatsiya va avtorizatsiya

### 6.1. Ikki sub'ekt

| Sub'ekt | Kirish yo'li | Token |
|---|---|---|
| **User** (back-office) | email+parol+2FA **yoki** Google (Firebase) | JWT access 15 min + refresh 30 kun |
| **Driver** (mobil/planshet) | username + parol | JWT access 24 soat + refresh 90 kun |

> **Qurilma sub'ekti yo'q.** PT30 HTTP so'rov yubormaydi — ingest drayver tokeni bilan bajariladi.

### 6.2. Google Sign-In (Firebase)

> **⚠️ 2026-09-13 — 2FA/TOTP butunlay olib tashlandi, foydalanuvchining aniq buyrug'i bilan
> (D-050, `backend/decisions.md`).** Quyidagi bo'limda tilga olingan `pendingTwoFactorToken`,
> `POST /auth/2fa/verify`, `TwoFactorSetupGuard`, "Admin uchun 2FA majburiy" qoidasi va
> `twoFactorEnabled`/`twoFactorSecret`/`recoveryCodes` maydonlari **kod bazasida mavjud emas**.
> `POST /auth/login` va `POST /auth/google` endi har doim to'g'ridan-to'g'ri access+refresh
> tokenlarni qaytaradi. Qolgan matn faqat tarixiy kontekst uchun saqlanmoqda.

Repoda `firebase-service-account.json` allaqachon bor.

```
1. Frontend: Firebase Web SDK → signInWithPopup(GoogleAuthProvider)
2. Frontend: Firebase ID token oladi
3. Frontend → POST /v1/auth/google  { idToken }
4. Backend: firebase-admin.auth().verifyIdToken(idToken)
5. Backend tekshiradi:
   - token.firebase.sign_in_provider === 'google.com'   → aks holda 401
   - token.email_verified === true                      → aks holda 403 EMAIL_NOT_VERIFIED
   - token.aud === bizning Firebase project ID          → aks holda 401
6. Backend: email bo'yicha User topadi
   - topilsa    → googleUid yoziladi
   - topilmasa  → 403 USER_NOT_INVITED
7. 2FA darvozasi (quyida) → o'tsa JWT access + refresh
```

**Qat'iy qoida 1 — avtomatik ro'yxat yo'q.** Google orqali kirish **ro'yxatdan o'tkazmaydi**. Foydalanuvchini avval Admin `Invite user` orqali qo'shadi. Aks holda istalgan Gmail egasi panelga kira olardi.

**Qat'iy qoida 2 — Google 2FA ni chetlab o'tmaydi.** ⚠️

Ilgari bu TZ da «Google orqali kirganda TOTP so'ralmaydi, chunki Google o'zi ikki bosqichli» deyilgan edi. **Bu noto'g'ri:** Google akkauntda 2FA yoqilganligi kafolatlanmaydi va ID token buni ishonchli aytmaydi. Natijada `twoFactorEnabled = true` bo'lgan admin shunchaki «Continue with Google» tugmasini bosib TOTP ni aylanib o'tardi — ya'ni majburiy 2FA qoidasi teshik edi.

To'g'ri qoida:

| Foydalanuvchi holati | Parol bilan | Google bilan |
|---|---|---|
| `twoFactorEnabled = false`, rol ≠ ADMIN | TOTP yo'q | TOTP yo'q |
| `twoFactorEnabled = true` | **TOTP so'raladi** | **TOTP so'raladi** |
| Rol = `ADMIN` | **TOTP majburiy** | **TOTP majburiy** |

Ya'ni 2FA **kirish usuliga emas, foydalanuvchiga** bog'langan. Google oqimi ham `pendingTwoFactorToken` qaytaradi va `POST /auth/2fa/verify` bilan yakunlanadi — parol oqimi bilan bir xil.

**Admin uchun 2FA majburiy:** `twoFactorEnabled = false` bo'lgan admin kirsa, unga faqat `/me/security` sahifasi ochiladi va TOTP sozlamaguncha boshqa endpointlar `403 TWO_FACTOR_SETUP_REQUIRED` qaytaradi.

### 6.3. Token tarkibi

```json
{
  "sub": "usr_9f2a...",
  "typ": "user",
  "rol": "FLEET_MANAGER",
  "per": { "vehicles": "FULL", "hos": "READ", "auditLog": "NONE" },
  "iat": 1789000000,
  "exp": 1789000900
}
```

### 6.4. Ruxsat modeli

```ts
type PermissionLevel = 'NONE' | 'READ' | 'FULL';

const PERMISSION_KEYS = [
  'dashboard', 'liveFleet', 'vehicles', 'drivers', 'hos', 'hosEdit',
  'hosCertifyOnBehalf', 'dvir', 'maintenance', 'safety', 'trips',
  'reports', 'reportsTransfer', 'messaging', 'devices', 'alertRules',
  'users', 'roles', 'integrations', 'auditLog', 'support', 'carrierSettings',
] as const;
```

**To'liq matritsa — 22 kalitning hammasi.** Ilgari jadvalda faqat 11 tasi bor edi, qolganlari aniqlanmagan qolardi.

| Kalit | ADMIN | FLEET_MANAGER | DISPATCHER | VIEWER |
|---|---|---|---|---|
| `dashboard` | FULL | FULL | FULL | READ |
| `liveFleet` | FULL | FULL | FULL | READ |
| `vehicles` | FULL | FULL | READ | READ |
| `drivers` | FULL | FULL | READ | READ |
| `hos` | FULL | FULL | READ | READ |
| `hosEdit` | FULL | FULL | NONE | NONE |
| `hosCertifyOnBehalf` | FULL | NONE | NONE | NONE |
| `dvir` | FULL | FULL | READ | READ |
| `maintenance` | FULL | FULL | READ | READ |
| `safety` | FULL | FULL | READ | READ |
| `trips` | FULL | FULL | **FULL** | NONE |
| `reports` | FULL | FULL | READ | READ |
| `reportsTransfer` | FULL | FULL | **NONE** | NONE |
| `messaging` | FULL | FULL | FULL | NONE |
| `devices` | FULL | FULL | READ | NONE |
| `alertRules` | FULL | FULL | NONE | NONE |
| `users` | FULL | NONE | NONE | NONE |
| `roles` | FULL | NONE | NONE | NONE |
| `integrations` | FULL | NONE | NONE | NONE |
| `auditLog` | FULL | NONE | NONE | NONE |
| `support` | FULL | FULL | FULL | READ |
| `carrierSettings` | FULL | NONE | NONE | NONE |

**Ikki tuzatish:**

1. `reportsTransfer` `DISPATCHER` uchun `READ` edi → **`NONE`**. «Uzatish» — amal, unga `READ` ma'nosiz. Bundan tashqari rol qo'llanmalari (`eld.docs/web/*.pdf`) va Figma aniq aytadi: FMCSA paketini **faqat Administrator va Fleet manager** yuboradi.
2. `trips` `DISPATCHER` uchun `FULL` — dispetcherning asosiy ishi aynan shu. Ilgari jadvalda umuman yo'q edi.

**Interpretatsiya qoidasi:**

| Daraja | Ma'nosi |
|---|---|
| `NONE` | Endpoint `403`. Menyu punkti va tugma **ko'rsatilmaydi** |
| `READ` | Faqat `GET`. Eksport va chop etish ochiq |
| `FULL` | `GET` + `POST/PATCH/DELETE` + amallar |

`ADMIN` roli `isSystem = true` — o'chirib yoki tahrirlab bo'lmaydi (Figma: «Admin cannot be edited»).

### 6.5. Xavfsizlik

- Parol: Argon2id (`memoryCost=19456, timeCost=2, parallelism=1`)
- Refresh token: DB'da SHA-256 hash, rotatsiya har ishlatishda
- 2FA: TOTP (RFC 6238), 8 ta recovery kod
- Rate limit: login 5/daq/IP, API 600/daq/token, ingest 300/daq/driver
- Barcha DTO — zod, `ZodValidationPipe`
- SQL faqat Prisma; `$queryRaw` faqat parametrlashtirilgan
- CORS: faqat ro'yxatdagi domenlar · Helmet · HSTS
- Firebase service account fayli repoda **saqlanmaydi** — serverdagi sirlar papkasida

---

## 7. Ingest — ilovadan keladigan ma'lumot

### 7.1. Endpointlar

```
POST /v1/ingest/events        — ELD hodisalari
POST /v1/ingest/telemetry     — Virtual Dashboard nuqtalari
POST /v1/ingest/ble-state     — BLE holati o'zgarishi
POST /v1/ingest/device-status — stored events soni, firmware
```

Barchasi **drayver JWT** bilan. `Authorization: Bearer <driver access token>`.

### 7.2. Hodisa yuborish

```json
POST /v1/ingest/events
{
  "deviceSerial": "PT30_A86E",
  "vehicleId": "veh_...",
  "sdkVersion": "6.7.1",
  "batch": [
    {
      "uuid": "3f2a-...",
      "eventType": 1,
      "eventCode": 3,
      "eventDateTime": "2025-09-10T06:30:44Z",
      "timezoneOffset": -240,
      "recordOrigin": 1,
      "wasStoredOnDevice": false,
      "latitude": 39.961176,
      "longitude": -82.998794,
      "rawDeviceOdometerKm": 1598200,
      "totalEngineHours": 1070.7,
      "checksum": "a3f9..."
    }
  ]
}
```

### 7.3. Qoidalar

1. **Idempotentlik** — `uuid` bo'yicha. Takroriy → `200 OK`, yangi yozuv yo'q
2. **Batch** — maksimum 500 hodisa, 1 MB
3. **Eski hodisa qabul qilinadi** — qurilma 30 kun saqlashi mumkin
4. **Checksum** mos kelmasa → hodisa **baribir yoziladi**, `diagnostic 3` qo'yiladi, javob `202 ACCEPTED_WITH_WARNINGS`
5. **Vaqt farqi — yagona chegara 10 daqiqa.** Qurilma vaqti serverning UTC vaqtidan `|Δ| > 10 daq` farq qilsa → hodisa **qabul qilinadi**, lekin `malfunction T` yoziladi va `timeDriftSec` saqlanadi
6. Butun batch **bitta tranzaksiyada**
7. Odometr: `totalVehicleMiles = kmToMi(rawDeviceOdometerKm) + vehicle.odometerOffsetMi`
8. **`eventSequenceId`** shu yerda beriladi — drayver bo'yicha ketma-ket, `1..65535`
9. **Joylashuv aniqligi** — koordinata saqlashdan **oldin** qo'pollashtiriladi:
   - `ON` / `D` / `SB` / `OFF` → **1 milya** (`locationPrecisionMi = 1`)
   - PC (`eventType=3, code=1`) faol → **10 milya** (`locationPrecisionMi = 10`)
   Xom koordinata **hech qayerda saqlanmaydi** — `EldEvent` da ham, `TelemetryPoint` da ham
10. Qabul qilingach → `hos.recalc` job va `realtime.push`

> **Nega hodisa rad etilmaydi.** Ilgari 4- va 5-qoidalar hodisani `422` bilan rad etardi. Bu FMCSA nuqtayi nazaridan xato: ELD yozgan hodisa **yo'qotilmasligi kerak**. To'g'ri yo'l — qabul qilib, malfunction/diagnostic bilan belgilash. Rad etish faqat sxema buzilganda (`400`) bo'ladi.

> **Nega vaqt chegarasi 10 daqiqa.** Ilgari ikki xil raqam bor edi: bu yerda **5 daqiqa**, 7.8-bo'limda **10 daqiqa**. FMCSA timing malfunction chegarasi — UTC dan **10 daqiqadan ortiq** og'ish. Endi ikkala joyda ham 10.

### 7.4. `wasStoredOnDevice` — kimga tegishli ekanini aniqlash

Bu bayroq hodisa **BLE uzilganda qurilma xotirasida** yotganini bildiradi. Kimga tegishli ekani quyidagi **ketma-ket** tartib bilan aniqlanadi — birinchi mos kelgan qoida ishlaydi, keyingilari tekshirilmaydi.

| # | Shart | Natija |
|---|---|---|
| **1** | Bo'shliq davomida o'sha unitda **faol drayver sessiyasi** bor edi (login qilingan, logout qilinmagan) | `driverId` = o'sha drayver · `recordOrigin = 1` · unidentified segment **yaratilmaydi** |
| **2** | Sessiya yo'q, lekin bo'shliqdan **oldin va keyin** ayni bir drayver ayni unitda faol edi va bo'shliq **≤ 2 soat** | `driverId` = o'sha drayver · `recordOrigin = 1` · drayverga **tasdiqlash so'rovi** yuboriladi |
| **3** | Qolgan barcha holat | `driverId = null` · `recordOrigin = 4` · **`UnidentifiedSegment` yaratiladi** |

```
Misol — 1-qoida:
  08:30 John Smith #101 ga login qildi, ilova BLE ga ulandi
  11:00 telefon kabinada qoldi, John yuk tashishga chiqdi → BLE OUT_OF_RANGE
  11:40 telefon qaytdi → 8 ta stored event oqib chiqdi
  → Sessiya butun vaqt davomida ochiq edi → hodisalar John'niki, origin = 1
  → Unidentified segment YO'Q, drayverni bezovta qilmaydi
```

#### ⚠️ `recordOrigin` unidentified biriktirilganda **o'zgarmaydi**

Ilgari bu TZ da «drayver tasdiqlasa `recordOrigin = 2`» deb yozilgan edi. **Bu xato.**

`recordOrigin = 2` — «**drayver qo'lda kiritgan**» degani. Lekin bu hodisalarni ELD avtomatik yozgan — drayver faqat ularni **o'ziniki deb tan oldi**. Avtomatik yozilgan haydash vaqtini «qo'lda kiritilgan» deb belgilash auditor uchun eng jiddiy signal: §395.30 ning butun mazmuni aynan haydash vaqtini qo'lda yasashni taqiqlashdan iborat.

To'g'ri model:

| Maydon | Qiymat |
|---|---|
| `recordOrigin` | **`1` bo'lib qoladi** — hodisani ELD yozgan |
| `driverId` | biriktirilgan drayver |
| `UnidentifiedSegment.status` | `ASSIGNED` |
| `assignedById`, `assignedAt` | kim va qachon biriktirdi |
| `AuditLog` | `UNIDENTIFIED_ASSIGNED` — majburiy |

Drayver rad etsa: `status = REJECTED`, hodisalar `recordOrigin = 4` va `driverId = null` bo'lib qoladi, fleet manager ularni boshqa drayverga biriktirishi mumkin.

`recordOrigin = 2` faqat drayverning **haqiqatan qo'lda kiritgan** yozuvlariga qo'yiladi: unutilgan ON-duty vaqtini qo'shish, izoh, shipping document.

#### Tasdiqlash so'rovi

2-qoida ishlaganda drayverga push va ilovada banner ketadi:

```
POST /v1/unidentified/:id/confirm   { accepted: true | false, annotation?: string }
```

- 8 kun ichida javob bo'lmasa → avtomatik `status = PENDING` bo'lib qoladi va fleet manager panelida turadi
- Bu hodisalar shu vaqtgacha **drayverning HOS hisobiga kiradi** (1-qoida bo'yicha unga tegishli deb belgilangan), chunki haydash vaqti hech qachon «kutish» holatida yo'qolmaydi

### 7.5. Telemetriya va downsampling

PT30 sozlamalari (hujjatdagi o'zgaruvchilar):

| O'zgaruvchi | Ma'nosi | Default | Bizning qiymat |
|---|---|---|---|
| `PE` | Ulangan holatda periodic hodisa oralig'i | 10 sek | **30 sek** (3.2 va 5.4 bilan bir xil) |
| `PN` | BLE yo'q, dvigatel ishlayapti | 30 daq | **30 daq** (o'zgarmaydi) |

**Ilova qoidasi:**
- BLE'dan har 30 sekundda nuqta oladi → **jonli UI uchun** ishlatadi
- Serverga **60 sekundda bitta** nuqta yuboradi (downsampling)
- Lekin **barcha transition hodisalari** (dvigatel, duty status, DTC) hech qachon tashlanmaydi

Bu qoida DB hajmini ikki barobar kamaytiradi va jonli tajribani buzmaydi.

### 7.6. BLE holati

```json
POST /v1/ingest/ble-state
{ "deviceSerial": "PT30_A86E", "state": "OUT_OF_RANGE", "at": "..." }
```

Holatlar (hujjatdagi diagramma bo'yicha): `CONNECTED` · `OUT_OF_RANGE` · `DISCONNECTED`

- `OUT_OF_RANGE` — drayver telefon bilan uzoqlashdi (odatiy hol, ogohlantirish yo'q)
- `DISCONNECTED` — ilova ataylab uzdi
- 30 daqiqadan ortiq ulanmasa → `alert.eld_disconnected`

### 7.7. Stored events oqimi

```json
POST /v1/ingest/device-status
{ "deviceSerial": "PT30_A86E", "storedEventsCount": 42, "firmware": "L113" }
```

- Panelda "42 ta hodisa yuklanmagan" ko'rsatiladi
- 100 dan oshsa → `alert.device_backlog`
- Ilova `RetrieveStoredEvents()` chaqirib, ACK bilan yuklab oladi va serverga yuboradi
- Yuklangach qurilma ularni o'chiradi

### 7.8. Avtomatik tekshiruvlar (backend tomonda)

| Kod | Shart |
|---|---|
| `P` power compliance | 24 soatda jami 30 daq+ quvvat uzilishi |
| `E` engine sync | 24 soatda 30 daq+ ECM ma'lumoti yo'q |
| `T` timing | Qurilma vaqti UTC dan 10 daq+ farq (7.3, qoida 5 bilan bir xil chegara) |
| `L` positioning | 60 daq+ geo-joylashuv yo'q |
| `R` data recording | Xotira to'lgan / yozuv yo'qolgan |
| `S` data transfer | Uzatish 3 marta ketma-ket muvaffaqiyatsiz |
| `5` unidentified | 24 soatda 30 daq+ aniqlanmagan haydash |
| `3` missing data | Checksum xato yoki majburiy maydon yo'q |

**Haydash aniqlash:** tezlik ≥ 5 mph → `D`. Harakatsiz 5 daqiqa → drayverga so'rov; 1 daqiqada javob bo'lmasa → `ON`. Haydash paytida har 60 daqiqada `intermediate log` bo'lishi shart.

---

## 8. HOS qoidalari dvigateli ⭐

### 8.1. Interfeys

```ts
export interface HosInput {
  events: NormalizedEvent[];      // recordStatus=1, vaqt bo'yicha saralangan
  driver: DriverHosConfig;
  ruleset: HosRuleset;
  now: Date;

  /** ⭐ Drayverning HOME TERMINAL mintaqasi — Carrier.timezone EMAS.
   *  RODS kuni aynan shu mintaqada yarim tundan yarim tungacha bo'linadi. */
  timezone: string;               // driver.homeTerminalTimezone

  /** ⭐ Recap uchun oldingi 7 (yoki 6) kunning HAR BIRI alohida kerak.
   *  Ilgari bu yerda bitta `previousCycleSeconds: number` bor edi —
   *  bitta yig'indi bilan "8 kun oldingi kun soatlari qaytadi" qoidasini
   *  hisoblab bo'lmaydi, chunki qaysi kun tushib qolayotgani bilinmaydi. */
  previousDays: Array<{
    date: string;                 // "YYYY-MM-DD" — home terminal mintaqasida
    onDutySec: number;            // ON + D jami (cycle'ga kiradigan vaqt)
  }>;

  /** 34 soatlik restart oxirgi marta qachon tugagan (bo'lsa).
   *  Shu vaqtdan oldingi kunlar cycle hisobiga kirmaydi. */
  lastRestartEndedAt: Date | null;
}

export interface HosState {
  currentStatus: DutyStatus;
  statusSince: Date;
  driveRemainingSec: number;
  shiftRemainingSec: number;
  breakRemainingSec: number;
  cycleRemainingSec: number;
  driveUsedSec: number;
  shiftStartedAt: Date | null;
  lastBreakEndedAt: Date | null;
  violations: Violation[];
  nextBreakDueAt: Date | null;
  shiftEndsAt: Date | null;
  cycleRecapAt: Date | null;
  restartAvailableAt: Date | null;
  dailyTotals: { off: number; sb: number; drive: number; on: number };
}

export function computeHos(input: HosInput): HosState;
```

### 8.2. Qoidalar (US property-carrying)

| # | Qoida | Tafsilot |
|---|---|---|
| 1 | **11 soatlik haydash** | 10 soat uzluksiz off-duty dan keyin maks 11 soat |
| 2 | **14 soatlik oyna** | Smena boshidan 14 soat. To'xtash oynani to'xtatmaydi |
| 3 | **30 daqiqalik tanaffus** | 8 soat jami haydashdan keyin ≥30 daq haydamaslik (OFF/SB/ON) |
| 4 | **70/8 yoki 60/7** | 8 (7) kunda maks 70 (60) soat on-duty |
| 5 | **34 soatlik restart** | 34 soat uzluksiz OFF/SB → cycle nolga |
| 6 | **Recap** | Restart bo'lmasa, 8 kun oldingi kun soatlari qaytadi |
| 7 | **Split sleeper** | Quyida — 8.2.1 |
| 8 | **Adverse driving** | 11→13 va 14→16 soat |
| 9 | **Short-haul** | 150 havo-milya, 14 soat → RODS shart emas |
| 10 | **Personal conveyance** | OFF, haydash vaqtiga qo'shilmaydi, joylashuv aniqligi 10 milya |
| 11 | **Yard move** | ON, haydash vaqtiga qo'shilmaydi |

### 8.2.1. ⚠️ Split sleeper — batafsil

**Kvalifikatsiya shartlari:**

| Qism | Talab |
|---|---|
| Uzunroq | **≥ 7 soat** uzluksiz **sleeper berth** (faqat SB) |
| Qisqaroq | **≥ 2 soat** uzluksiz **SB yoki OFF** |
| Jami | Ikkalasi qo'shilib **≥ 10 soat** |

Ya'ni amalda **8/2** yoki **7/3** (yoki 7.5/2.5 kabi oraliq juftliklar).

**Oynaga ta'siri — eng ko'p xato qilinadigan joy:**

> **Ikkala kvalifikatsiyalangan qism ham 14 soatlik oynadan chiqariladi.** Faqat uzunrog'i emas.

Bu qoida 2020-yil 29-sentyabrdan amal qiladi. Ilgari (2020 gacha) faqat ≥8 soatlik SB oynani to'xtatardi — TZ ning oldingi versiyasida aynan **eski qoida** yozilgan edi. Uni qoldirsak, split sleeper ishlatadigan har bir drayverga **soxta 14-soatlik buzilish** yozilardi.

> ### ⛔ SUPERSEDED — quyidagi "Hisoblash tartibi" 1-bandi va "Misol" bloki 49 CFR §395.1(g)(1) bilan ALMASHTIRILDI
>
> Quyida yozilgan **NOLLASH** (reset) qoidasi noto'g'ri: u CFR dan **yumshoqroq** va
> `DRIVING_11` / `SHIFT_14` buzilishlarini **kam ko'rsatadi**. §395.1(g)(1) NOLLASHNI emas,
> **ORQAGA QARASHNI (look-back)** talab qiladi:
>
> * Ikkinchi kvalifikatsiyalangan qism tugaganda hisob **birinchi** qism TUGAGAN paytdan
>   qayta hisoblanadi;
> * Ikki qism **orasida** haydalgan vaqt 11 soatlik hisobda **QOLADI** (nollanmaydi);
> * 14 soatlik oyna birinchi qism tugagan paytdan boshlanadi, **ikkinchi** kvalifikatsiyalangan
>   qism esa oynadan chiqariladi (ikkala qism ham oynadan tashqarida bo'ladi).
>
> **To'g'ri natija (quyidagi "Misol" uchun):** 8 soat SB → 4 soat D → 2 soat SB juftligi
> yopilganda drive left = **7 soat** (11 emas), shift ends = birinchi qism tugagan payt
> (13:00) + 14 soat + chiqarilgan 2 soat = **05:00** (09:00 emas).
>
> **Nega:** repodagi ustuvorlik tartibi **FMCSA 49 CFR §395 > pt30_docs > tz.md**. §8.2.1 ning
> nollash matni TZ xatosi deb tan olindi; egasining qarori `backend/decisions.md` **D-012** da.
> Engine va `backend/test/conformance/golden/` fixture'lari look-back bo'yicha ishlaydi.
> Kvalifikatsiya shartlari (≥7 soat SB + ≥2 soat SB/OFF, jami ≥10 soat) va "ikkala qism ham
> oynadan chiqariladi" qoidasi — **o'zgarishsiz, to'g'ri**.

**Hisoblash tartibi:**

```
1. ⛔ SUPERSEDED (§395.1(g)(1) — yuqoriga qarang). Juftlik yopilganda:
   - ESKI (noto'g'ri) matn: 11 va 14 soatlik hisoblar NOLLANADI, yangi hisob
     ikkinchi qism TUGAGAN paytdan boshlanadi
   - AMALDAGI qoida: hisob BIRINCHI qism tugagan paytdan qayta hisoblanadi,
     qismlar orasida haydalgan vaqt 11 soatlik hisobda qoladi,
     ikkinchi qism 14 soatlik oynadan chiqariladi

2. Juftlik yopilgunicha (birinchi qismdan keyin, ikkinchisidan oldin):
   - Birinchi qism oynadan CHIQARILADI
   - Haydash vaqti to'planib boradi (nollanmaydi)
   - Oyna birinchi qismning davomiyligiga UZAYADI

3. Har bir qism faqat BIR juftlikda ishlatiladi.
   Uch qism bo'lsa — eng yaqin kvalifikatsiyalangan juftlik olinadi,
   uchinchisi keyingi juftlikning birinchi qismi bo'lishi mumkin.
```

**Misol (⛔ kutilgan natijalari SUPERSEDED — §395.1(g)(1) bo'yicha tuzatilgan):**

```
02:00–10:00  SB   (8 soat — uzunroq qism, BIRINCHI)
10:00–14:00  D    (4 soat haydash — ikki qism ORASIDA)
14:00–16:00  SB   (2 soat — qisqaroq qism, IKKINCHI)  → juftlik YOPILDI
16:00–…      D

16:00 da (AMALDAGI, §395.1(g)(1) look-back):
           drive used  = 4:00  (10:00–14:00 orasidagi haydash SAQLANADI)
           drive left  = 7:00
           shift start = 10:00 (birinchi qism tugagan payt)
           shift ends  = 10:00 + 14:00 + 2:00 (chiqarilgan ikkinchi qism) = 02:00

16:00 da (ESKI, tz.md §8.2.1 nollash matni — NOTO'G'RI, ishlatilmaydi):
           drive left = 11:00 (nollangan)
           shift ends = 16:00 + 14:00 = 06:00 (nollangan)

Agar faqat uzunroq qism chiqarilganda (ESKI, XATO qoida):
           14:00–16:00 oynada qolardi → oyna 2 soat qisqa bo'lardi
           → 04:00 da soxta 14-soatlik buzilish
```

### 8.3. Algoritm

```
0. Kun chegaralari — `driver.homeTerminalTimezone` bo'yicha (Carrier.timezone emas)
1. Normallashtirish — recordStatus=1, saralash, PC/YM qo'llash, intermediate ajratish
2. Segmentlar — hodisalar orasi + oxirgisidan `now` gacha
3. Smena aniqlash — ≥10 soat uzluksiz OFF/SB **yoki** yopilgan split juftlik (8.2.1)
4. Limitlarni hisoblash — drive, shift, break, cycle (recap bilan)
5. Buzilishlar — oshgan daqiqa, exceededBySec, idempotent yozuv
6. Prognoz — nextBreakDueAt, shiftEndsAt, cycleRecapAt, restartAvailableAt
```

### 8.4. Qayta hisoblash

Qayta hisoblanadi: yangi hodisa · tuzatish qabul qilinganda (o'sha kundan **oldinga**) · unidentified biriktirilganda · istisno o'zgarganda (**faqat kelajakka**).

```ts
{ name: 'hos.recalc', data: { driverId, fromDate } }
```

Job **idempotent** va **drayver bo'yicha serial** (`groupKey: driverId`).

**Buzilishlarni yozish qoidasi (idempotent `upsert`):**

```
Har bir qayta hisoblangan kun uchun:
  1. Yangi natijani (driverId, logDate, type) kaliti bo'yicha UPSERT qilish
     — occurredAt, exceededBySec, detail yangilanadi, id o'zgarmaydi
  2. O'sha kun uchun natijada YO'Q bo'lgan, lekin bazada OPEN turgan buzilishlarni
     status = AUTO_CLEARED ga o'tkazish (o'chirmaydi — audit qoladi)
  3. Qo'lda RESOLVED qilingan buzilish qayta OPEN qilinmaydi,
     faqat exceededBySec yangilanadi
```

Bu qoidasiz har recalc yangi qator yaratib, hisoblagichni («2 open violations») shishirib yuboradi.

### 8.5. Test talablari

**Minimal 300 ta unit test.** Har qoida uchun limit ostida / aynan / oshgan.

**Majburiy ssenariylar:**

| Guruh | Ssenariylar |
|---|---|
| Split sleeper | 8/2 · 7/3 · 7.5/2.5 · **ikkala qism ham oynadan chiqarilishi** · qism 6:59 (kvalifikatsiya bo'lmaydi) · uch qism ketma-ket · juftlik yopilmagan holat |
| Restart | 33:59 (yetmaydi) · 34:00 (aynan) · restart ichida ON bo'lib qolishi |
| Recap | siljiydigan 8 kunlik oyna · restartdan keyingi recap · `previousDays` bo'sh |
| Break | 7:59 va 8:00 haydash · 29 va 30 daqiqa tanaffus · ON bilan tanaffus |
| Adverse | 11→13 · 14→16 · ikkalasi birga |
| Vaqt | DST mart (23 soatlik kun) · DST noyabr (25 soatlik kun) · yarim tunda kun almashishi · **home terminal ≠ carrier mintaqasi** |
| PC / YM | PC haydash vaqtiga qo'shilmasligi · YM ON bo'lishi · PC joylashuvi 10 milya |
| Chegara | bo'sh ro'yxat · bitta hodisa · 10 000 hodisa · kelajakdagi hodisa |

> **Diqqat:** oldingi versiyada split sleeper testi «8/2, 7/3» deb qisqa yozilgan edi va spetsifikatsiyaning o'zi xato bo'lgani uchun test ham **xatoni tasdiqlardi**. Endi «ikkala qism ham oynadan chiqariladi» alohida test sifatida majburiy.

**Oltin testlar:** `hos/fixtures/fmcsa/*.json` — FMCSA hujjatlaridagi misollar, aynan mos natija.

> `eld.docs/pt30_docs/HOS_Simulator.pdf` — Pacific Track ning HOS simulyatori. Undan test ssenariylarini olish tavsiya etiladi.

### 8.6. ⚠️ Dvigatel ikki joyda yashaydi

FMCSA talabi: drayver **internetsiz ham** o'zining qolgan soatlarini ko'rishi shart. Ya'ni HOS hisobi **ilovada ham** bajarilishi kerak — serverni kutib turib bo'lmaydi.

Demak bitta qoidalar to'plami **ikki marta** yoziladi:

| Amalga oshirish | Til | Vazifasi |
|---|---|---|
| `hos/engine/` | TypeScript | Server — haqiqat manbai, hisobotlar, buzilishlar |
| `lib/hos/engine/` | Dart | Ilova — jonli soatlar, offline ish |

**Bu eng katta muvofiqlik xavfi.** Ikki implementatsiya bir-biridan chetga chiqsa, drayver ilovada bir raqamni, inspektor serverdan boshqa raqamni ko'radi.

**Majburiy himoya choralari:**

1. **Yagona spetsifikatsiya** — 8.2 va 8.3-bo'limlar. Har ikkala implementatsiya faqat shundan yoziladi.

2. **Umumiy oltin testlar.** `backend/test/conformance/golden/` papkasida til-neytral JSON fayllar:
   ```json
   {
     "name": "11-hour limit exceeded by 26 min",
     "input": { "events": [...], "driver": {...}, "now": "...", "timezone": "..." },
     "expected": { "driveRemainingSec": 0, "violations": [{ "type": "DRIVING_11", "exceededBySec": 1560 }] }
   }
   ```
   - TypeScript testlari bu fayllarni o'qiydi
   - Dart testlari **aynan o'sha fayllarni** o'qiydi
   - Ikkalasi ham 100% o'tishi shart

3. **CI darvozasi.** Backend va mobil repolarining ikkalasida ham conformance testlari majburiy. Bittasi tushса — merge yo'q.

4. **Versiyalash.** `HOS_ENGINE_VERSION` konstantasi ikkala tomonda bir xil bo'lishi kerak. Ilova serverga versiyani yuboradi:
   ```
   GET /v1/mobile/bootstrap → { hosEngineVersion: "1.4.0", ... }
   ```
   Mos kelmasa — ilovada banner: *"Ilovani yangilang — HOS hisobi eskirgan"*.

5. **Kunlik solishtirish.** Ilova hisoblagan holatni serverga yuboradi, server o'z hisobi bilan solishtiradi.

   Ilgari bu band «server ilovaning oxirgi yuborgan holati bilan solishtiradi» deb yozilgan edi, lekin **ilova holatni yuboradigan endpoint yo'q edi** — `POST /mobile/sync` payload'ida faqat `hosEngineVersion` bor. Ya'ni solishtiradigan narsa yo'q edi va `alert.hos_engine_drift` hech qachon ishlamasdi.

   ```
   POST /v1/mobile/hos-state
   {
     "computedAt": "2025-09-10T15:41:00Z",
     "hosEngineVersion": "1.4.0",
     "state": {
       "currentStatus": "ON",
       "driveRemainingSec": 0,
       "shiftRemainingSec": 1140,
       "breakRemainingSec": 7440,
       "cycleRemainingSec": 46140,
       "dailyTotals": { "off": 27000, "sb": 7200, "drive": 41160, "on": 11040 },
       "violations": [{ "type": "DRIVING_11", "exceededBySec": 1560 }]
     }
   }
   ```

   - Ilova buni **har HOS hisobidan keyin** (maksimum 5 daqiqada bir marta) yuboradi
   - Offline bo'lsa navbatga tushadi va aloqa tiklanganda ketadi
   - Server oxirgi holatni `DriverHosSnapshot` da saqlaydi
   - Tungi job har bir drayver uchun serverning hisobini snapshot bilan solishtiradi
   - Farq **60 sekunddan katta** bo'lsa → `alert.hos_engine_drift` + Sentry + panelda ogohlantirish
   - `hosEngineVersion` mos kelmasa — solishtirish **o'tkazilmaydi** (bu drift emas, eski ilova)

> **Muqobil variant (rad etilgan):** faqat serverda hisoblash va ilovaga tayyor raqamlarni berish. Bu FMCSA talabini buzadi — internet yo'q joyda soatlar muzlab qoladi.

---

## 9. RODS — jurnal, tuzatish, sertifikatlash

### 9.1. Tuzatish so'rovi (§395.30)

**Qat'iy qoida:** Driving (`eventType=1, eventCode=3`) davomiyligini **qisqartirib bo'lmaydi** → `422 DRIVING_TIME_IMMUTABLE`.

```
1. POST /v1/logs/:driverId/edit-requests
   { originalEventId, proposedStatus, proposedStart, proposedEnd,
     location, odometer, engineHours, reason }
2. Backend: ruxsat → immutability → yangi EldEvent (recordStatus=3, origin=3,
   supersedesId) → drayverga push → AuditLog
3. Drayver: qabul → yangi=1, eski=2 · rad → so'rov=4
4. hos.recalc
```

### 9.2. Sertifikatlash

```
POST /v1/logs/:driverId/certify
{ dates: ["2025-09-10"], signatureImageId: "sig_..." }
```

- Har sertifikatlash `eventType=4` hodisasi yaratadi
- `eventCode`: birinchi sertifikatlash `1`, qayta sertifikatlash `2..9`. **9 dan keyin `9` bo'lib qoladi** (Appendix A chegarasi). `DailyLog.certificationCount` esa haqiqiy sonni saqlaydi
- Jurnal o'zgarsa — qayta sertifikatlash talab qilinadi (`certified = false`)
- Admin drayver nomidan (`certifyOnBehalf=FULL`) → majburiy `AuditLog`
- **`alert.uncertified_logs` chegarasi — 8 kun.** Ya'ni 8 kunlik oynadagi eng eski sertifikatlanmagan kun oynadan chiqib ketish arafasida bo'lsa alert ketadi. (14-bo'limdagi seed jadvalida ilgari **3 kun** yozilgan edi — nomuvofiqlik tuzatildi, ikkala joyda ham **8 kun**)

### 9.3. Drayverning o'z jurnalini tuzatishi

Ilgari TZ da faqat **kompaniya taklif qiladigan** tuzatish oqimi yozilgan edi. Lekin FMCSA drayverning o'zi ham yozuvini to'g'rilay olishini talab qiladi — masalan yuklashda unutilgan ON-duty vaqti.

```
POST /v1/mobile/log-entries
{
  "date": "2025-09-10",
  "status": "ON",
  "startAt": "2025-09-10T18:00:00Z",
  "endAt":   "2025-09-10T18:45:00Z",
  "annotation": "Loading at shipper #4821",   // min 4, max 60 belgi
  "location": { "lat": ..., "lon": ..., "name": "Florence, KY" },
  "odometerMi": 993589
}
```

| Qoida | Tafsilot |
|---|---|
| `recordOrigin` | **`2`** — bu haqiqatan drayver qo'lda kiritgan yozuv |
| `recordStatus` | `1` — darhol faol, tasdiq kerak emas (bu o'z yozuvi) |
| Nima mumkin | OFF ↔ SB ↔ ON o'rtasida o'zgartirish · yangi ON/OFF/SB qo'shish · izoh qo'shish |
| Nima **mumkin emas** | `D` (Driving) segmentini qisqartirish, o'chirish yoki boshqa statusga o'tkazish → `422 DRIVING_TIME_IMMUTABLE` |
| Nima mumkin emas | `recordOrigin = 1` bo'lgan avtomatik hodisani o'chirish |
| Izoh | **majburiy**, minimum 4 belgi (Appendix A talabi) |
| Natija | Eski hodisa `recordStatus = 2`, yangisi `1`, `supersedesId` bog'lanadi |
| Audit | Har bir tuzatish `AuditLog` ga tushadi, sertifikatlash bekor bo'ladi |
| Offline | Ishlaydi — navbatga tushadi (13-bo'lim)

---

## 10. Ma'lumot uzatish (eRODS) — TEST rejimi

### 10.1. Hozirgi holat

FMCSA ro'yxatidan o'tish **hali boshlanmagan**. Shuning uchun:

```prisma
erodsMode     ErodsMode @default(TEST)          // TEST | PRODUCTION
eldIdentifier String    @default("OBK001") @db.VarChar(6)
```

> `eldIdentifier` — **aynan 6 belgi** `[A-Z0-9]` (Appendix A 7.15), `eldRegistrationId` — **aynan 4 belgi** (7.17). TEST rejimida `OBK001` (registration ID bo'sh bo'lishi mumkin); PRODUCTION'da — sertifikatlangan model/versiyaning ELD identifikatori va FMCSA bergan registration ID. Oldingi «4 belgi» qoidasi §395 ga zid edi (B-138, D-121).

**TEST rejimida:**
- Output fayl **to'liq va to'g'ri** generatsiya qilinadi
- FMCSA serveriga **yuborilmaydi** — fayl S3'ga saqlanadi va yuklab olinadi
- Panelda sariq banner: *"eRODS test rejimi — fayl FMCSA'ga yuborilmaydi"*
- `DataTransfer.status = TEST_ONLY`
- Email varianti ishlaydi (haqiqiy email ketadi), lekin ogohlantirish bilan

**PRODUCTION'ga o'tish** — faqat sozlama:
```
1. Carrier.eldIdentifier = sertifikatlangan ELD identifikatori (6 belgi, 7.15)
2. Carrier.eldRegistrationId = FMCSA bergan registration ID (4 belgi, 7.17)
3. Carrier.erodsMode = PRODUCTION
4. FMCSA credential'lari sirlar papkasiga qo'yiladi
```
Kod o'zgarmaydi.

### 10.2. Output fayl formati

§395 Appendix A 4.8.2.1 bo'yicha CSV (CRLF, har qatorda Line Data Check Value). Rasmiy matn: `docs/fmcsa/49cfr395-subpartB-appendixA.txt`; ustunlar jadvali — `transfers/segments.ts` (D-024), o'zgarishlar ro'yxati — `docs/erods-changes-2026-10-08.md`. Segmentlar tartibi (4.8.2.1.1–.11):

Header (7 qator) → User List → CMV List → ELD Event List (faqat 1/2/3-tur) → Annotations/Comments → Certification → Malfunctions and Data Diagnostic Events → ELD Login/Logout Report → CMV Engine Power-Up and Shut Down Activity → Unidentified Driver Profile Records → End of File (File Data Check Value, 4 hex).

> ⚠️ Oldingi versiyadagi tartib (Header → User → CMV → **Malfunction** → Event → … , login/logout va engine power segmentlarisiz) §395 ga mos emas edi (B-134). §395 ustun.

**Header 7-qator:** Registration ID (4 belgi, 7.17), ELD Identifier (**6 belgi**, 7.15), Authentication Value, Output File Comment (≤60).

#### Fayl nomi — Appendix A 4.8.2.2

⚠️ Oldingi versiyalarda `{ELD_IDENTIFIER}_{LastName}_{YYYYMMDD}.csv` va keyin `[familiya 5][prava 2][ketma-ketlik 2][kunlar 1].csv` (`SMITH38018.csv`) deb berilgan edi. **Ikkalasi ham FMCSA formati emas** (B-136). Appendix A 4.8.2.2 — 25 belgi + `.csv`:

```
(a) familiyaning dastlabki 5 HARFI, katta harf, 5 dan qisqa bo'lsa `_` bilan to'ldiriladi
(b) prava raqamining oxirgi 2 RAQAMI (2 tadan kam bo'lsa — oldidan `0`)
(c) prava raqamidagi barcha raqamlar yig'indisi, oxirgi 2 raqam (`0` bilan to'ldirilgan)
(d) fayl yaratilgan sana MMDDYY — drayver uy terminali vaqtida
(e) `-`
(f) 9 belgi — shu kunda shu drayver uchun nechanchi fayl ekani − 1, 9 raqam (`DataTransfer` dan)
.csv
```

```
John Smith · CDL W8569238 · 2026-09-11 (EDT) · shu kunning 1-fayli
→  SMITH + 38 + 41 + 091126 + - + 000000000  →  SMITH3841091126-000000000.csv
```

**Qoidalar:**
- Familiya qismida faqat harflar (`O'Brien` → `OBRIE`, `Ng` → `NG___`)
- Prava qismlarida faqat raqamlar hisobga olinadi (`7` → `07`)
- Sana — `createdAt` (header'dagi Current Date bilan bir xil lahza), uy terminali vaqti
- Ikkinchi fayl shu kuni `…-000000001.csv`; oraliq kunlari soni nomga **kirmaydi**

> **Amalga oshirish talabi:** fayl nomi generatori `transfers/filename.ts` da alohida sof funksiya (`createdAt` majburiy) va **unit test bilan qoplanadi** (familiya qisqa, apostrofli familiya, ketma-ketlik 01→02 = suffiks `000000000`→`000000001`, prava raqami qisqa). Figmadagi `ONEB01_Smith_20250910.csv` matni ham shunga moslanadi.

### 10.3. Yuborishdan oldingi validatsiya

| Tekshiruv | Kod | Daraja |
|---|---|---|
| Aniqlanmagan segment bor | `UNRESOLVED_UNIDENTIFIED` | warning |
| Sertifikatlanmagan kun bor | `UNCERTIFIED_LOGS` | warning |
| Faol malfunction bor | `ACTIVE_MALFUNCTION` | warning |
| Drayver topilmadi | `DRIVER_NOT_FOUND` | error |
| Oraliq 8 kundan katta | `RANGE_TOO_LARGE` | error |
| TEST rejimi | `ERODS_TEST_MODE` | warning |

`outputFileComment` maksimum **60 belgi**.

### 10.4. Email orqali uzatish — shifrlash majburiy

Ilgari faqat «email uzatish faqat `*.fmcsa.dot.gov` domeniga» deyilgan edi. Bu yetarli emas: FMCSA email orqali kelgan output faylni **shifrlangan** holda kutadi.

| Talab | Tafsilot |
|---|---|
| Qabul qiluvchi | Faqat `*.fmcsa.dot.gov`. Boshqa domen → `422 INVALID_TRANSFER_RECIPIENT` |
| Shifrlash | Fayl FMCSA ning **ochiq kaliti** bilan shifrlanadi, keyin biriktiriladi |
| Kalit | Sirlar papkasida (`FMCSA_PUBLIC_KEY`). TEST rejimida test kaliti ishlatiladi |
| Mavzu qatori | FMCSA belgilagan format |
| `DataTransfer.encrypted` | Email uzatishda **har doim `true`** bo'lishi kerak; `false` bo'lsa job xato bilan tugaydi |
| Web services | Shifrlash talab qilinmaydi — TLS yetarli |

TEST rejimida email **haqiqatan yuboriladi** (test manziliga), lekin `status = TEST_ONLY` va xabar matnida test ekani aytiladi.

---

## 11. API — to'liq ro'yxat

Prefiks `/v1`. Ro'yxatlar `?page&limit&sort&q`.

### 11.1. Auth
`POST /auth/login` · `/auth/login/driver` · `/auth/google` · `/auth/refresh` · `/auth/logout` · `/auth/password/forgot` · `/auth/password/reset` · `GET /auth/me`
(`/auth/2fa/verify`, `/auth/2fa/enroll`, `/auth/2fa/enable` removed 2026-09-13 — D-050, 2FA deleted.)

> **MB-9 (2026-09-21).** `POST /auth/login/driver` javobi qo'shimcha `driverId` maydonini
> qaytaradi: `{ accessToken, refreshToken, tokenType, driverId }`. Bu qo'shimcha (additive)
> o'zgarish — faqat drayver login javobiga tegishli, mobil ilovaga per-driver offline SQLite
> fayl nomini (`onebook_{driverId}.db`, `mobile/tz.md` §5.5) JWT'ni dekodlamasdan tanlash
> imkonini beradi. `POST /auth/login` va `POST /auth/google` (back-office `User`) javob shakli
> o'zgarishsiz qoladi.

### 11.2. Ingest
`POST /ingest/events` · `/ingest/telemetry` · `/ingest/ble-state` · `/ingest/device-status`

### 11.3. Fleet
`GET/POST /vehicles` · `GET/PATCH/DELETE /vehicles/:id` · `POST /vehicles/:id/calibrate-odometer` · `GET /vehicles/:id/telemetry` · `/vehicles/:id/histories?date=` · `/vehicles/:id/activities` · `/vehicles/:id/dtc` · `POST /vehicles/:id/assign-driver` · `POST /vehicles/import` · `GET /vehicles/export`
`GET/POST /drivers` · `GET/PATCH/DELETE /drivers/:id` · `GET /drivers/:id/hos` · `POST /drivers/:id/reset-password` · `POST /drivers/import` · `GET /drivers/export`
`GET/POST /co-driver-pairings` · `POST /co-driver-pairings/:id/end`
`GET/POST /devices` · `POST /devices/:id/pair` · `/devices/:id/unpair` · `GET /devices/:id/diagnostics` · `PATCH /devices/:id/settings`
`GET /live/fleet`

### 11.4. Compliance
`GET /logs/:driverId?date=` · `/logs/:driverId/range` · `/logs/:driverId/events`
`POST /logs/:driverId/edit-requests` · `/logs/edit-requests/:id/accept` · `/reject` · `/logs/:driverId/certify`
`GET/POST /violations` · `/violations/:id/resolve`
`GET/POST /unidentified` · `/unidentified/:id/assign` · `/annotate` · `/reject` · `POST /unidentified/:id/confirm` (drayver — 7.4)
`GET/POST /dvirs` · `GET /dvirs/:id`
`GET/POST /defects` · `POST /defects/:id/resolve`
`GET/POST/PATCH /work-orders`
`GET/POST /transfers`

### 11.5. Operatsiya
`GET/POST/PATCH /trips` · `POST /trips/:id/assign` · `/trips/auto-assign` · `GET /trips/unassigned-loads`
`GET /safety/events` · `/safety/scorecard` · `POST /safety/coaching`
`GET/POST /geofences`
`GET/POST /conversations` · `/conversations/:id/messages` · `POST /messages/broadcast`
`GET/POST /notifications` · `/notifications/read-all`

### 11.6. Hisobot
`POST /reports/generate` · `GET /reports` · `/reports/:id` · `/reports/:id/download` · `GET/POST /reports/schedules`
`GET /reports/ifta?quarter=` · `/reports/activity` · `/reports/dvir` · `/reports/fmcsa-pack`

### 11.7. Sozlama
`GET/PATCH /carrier` · `GET/POST/PATCH/DELETE /users` · `POST /users/:id/resend-invite`
`GET/POST/PATCH /roles` · `GET/POST/PATCH /alert-rules`
`GET/POST /integrations` · `/api-keys` · `GET /audit-log`
`GET/POST /support/tickets` · `POST /feedback`
`GET/PATCH /me/profile` · `GET /me/sessions` · `DELETE /me/sessions/:id`

### 11.8. Mobil-maxsus
`GET /mobile/bootstrap` · `POST /mobile/sync` · `/mobile/duty-status` · `GET /mobile/hos` · `POST /mobile/dvir` · `/mobile/signature`

**v3.1 da qo'shilgan:**

| Endpoint | Nima uchun |
|---|---|
| `POST /mobile/hos-state` | Ilova hisoblagan HOS holati — drift solishtiruvi (8.6, 5-band) |
| `POST /mobile/log-entries` | Drayverning o'z jurnalini tuzatishi (9.3) |
| `POST /mobile/push-tokens` · `DELETE /mobile/push-tokens/:token` | FCM token ro'yxati (12.7). Telefon va planshet alohida token |
| `POST /mobile/certify` | Offline sertifikatlash navbati (13.2) |
| `POST /mobile/transfers` | Offline DOT inspeksiyasidan keyingi uzatish navbati (13.5) |
| `POST /unidentified/:id/confirm` | «Bu sizmi?» so'roviga javob (7.4, 2-qoida) |

---

## 12. Real-time

> **Talab:** uchala mijoz ham real vaqtda ishlaydi. Foydalanuvchi sahifani yangilashi shart emas.

### 12.1. Transport

| Mijoz | Ilova ochiq (foreground) | Ilova fonda / yopiq |
|---|---|---|
| **Web panel** | WebSocket (Socket.IO) | — |
| **Mobil** | WebSocket | **FCM push** (Firebase) |
| **Planshet** | WebSocket | FCM push |

Firebase loyihasi allaqachon mavjud (`firebase-service-account.json`), shuning uchun push uchun qo'shimcha provayder kerak emas.

### 12.2. Ulanish va autentifikatsiya

```
wss://host/ws          ← faqat TLS. `ws://` hech qachon ishlatilmaydi
```

**Token query string'da yuborilmaydi.** Ilgari `ws://host/ws?token=<JWT>` yozilgan edi — bu ikki xato:
1. TLS yo'q — token ochiq ketadi
2. Query string reverse proxy, CDN va access loglarga **yozib qo'yiladi** — token log fayllarda qoladi

To'g'ri usul — ulanishdan keyingi birinchi xabar:

```
1. Mijoz  → wss://host/ws  (token yo'q)
2. Server → { "type": "auth.required" }
3. Mijoz  → socket.emit('auth', { token })   ← 5 sekund ichida
4. Server → { "type": "auth.ok", "currentSeq": 84250 }
   yoki uzadi (4401)
```

Muqobil: `Sec-WebSocket-Protocol: bearer, <token>` (brauzer uni loglamaydi).

- Token muddati tugasa server `auth.expired` yuboradi → mijoz refresh qiladi → `socket.emit('auth.renew', { token })`. **Ulanish uzilmaydi.**
- Har 25 sekundda `ping`/`pong`. 3 ta javobsiz ping → uzilgan deb hisoblanadi
- Qayta ulanish: eksponensial backoff `1s → 2s → 4s → 8s → 16s → 30s` (maksimum), jitter bilan
- WebSocket bloklangan tarmoqlarda (ba'zi korporativ Wi-Fi) — avtomatik `polling` transportiga tushish

### 12.3. ⭐ Yo'qolgan hodisalarni tiklash

Uzilish paytida yuborilgan hodisalar yo'qolmasligi kerak.

Har bir hodisada **global monoton o'suvchi** `seq` bo'ladi (xona bo'yicha emas — bitta Redis counter). Mijoz oxirgi ko'rgan `seq` ni saqlaydi va qayta ulanganda yuboradi:

```json
socket.emit('resume', { rooms: ['fleet','violations'], lastSeq: 84213 })
```

Server javob beradi:
```json
{ "missed": [ ...hodisalar... ], "currentSeq": 84250, "truncated": false }
```

- Yo'qolgan hodisalar Redis Stream'da **15 daqiqa** saqlanadi
- 15 daqiqadan ko'p uzilgan bo'lsa → `truncated: true` → mijoz **to'liq qayta yuklaydi** (REST `GET` bilan)
- Bu qoida barcha mijozlar uchun bir xil

### 12.4. Xonalar va obunalar

| Xona | Kim obuna bo'ladi |
|---|---|
| `fleet` | Web: Dashboard, Live Fleet · Planshet: Home |
| `violations` | Web: barcha rollar |
| `driver:{id}` | O'sha drayverning ilovasi + uning fleet manager'i |
| `vehicle:{id}` | Unit detali ochilgan foydalanuvchilar |
| `conversation:{id}` | Suhbat ishtirokchilari |

**Qoida:** mijoz **faqat ochiq ekranga kerak bo'lgan** xonaga obuna bo'ladi. Ekran yopilganda obuna bekor qilinadi. Bu server yukini va trafikni kamaytiradi.

### 12.5. Hodisalar

| Hodisa | Yuk | Kimga |
|---|---|---|
| `fleet.position` | vehicleId, lat, lon, speed, status, ts | `fleet` |
| `driver.status_changed` | driverId, status, since | `fleet`, `driver:{id}` |
| `hos.updated` | driverId, driveRemainingSec, shiftRemainingSec, cycleRemainingSec, breakRemainingSec | `driver:{id}`, `fleet` |
| `violation.created` | violation | `violations`, `driver:{id}` |
| `unidentified.created` | segment | `violations` |
| `device.ble_state` | deviceId, state | `fleet`, `vehicle:{id}` |
| `device.backlog` | deviceId, storedEventsCount | `fleet` |
| `dvir.submitted` | dvirId, vehicleId, hasDefects | `fleet` |
| `defect.created` | defect | `violations` |
| `trip.status_changed` | tripId, status, eta | `fleet` |
| `message.new` | message | `conversation:{id}`, `driver:{id}` |
| `edit_request.created` | editRequest | `driver:{id}` |
| `edit_request.resolved` | editRequestId, accepted | fleet manager'ga |
| `report.ready` | reportId, downloadUrl | so'ragan foydalanuvchiga |
| `sync.required` | reason | `driver:{id}` |

### 12.6. Throttling va yuk

| Hodisa | Cheklov |
|---|---|
| `fleet.position` | har unit uchun maks **1 / 10 sek** |
| `hos.updated` | har drayver uchun maks **1 / 30 sek** |
| Qolganlari | cheklovsiz (kam uchraydi) |

Ortiqcha hodisalar Redis'da yig'iladi, faqat **oxirgi holat** yuboriladi (throttle, debounce emas).

### 12.7. Push bildirishnomalar (FCM)

Ilova fonda bo'lganda WebSocket yopiladi. Shunda quyidagilar **push** orqali boradi:

| Hodisa | Ustuvorlik | Ovoz |
|---|---|---|
| HOS buzilishi | `high` | ha |
| Tanaffus 30 daqiqadan keyin | `high` | ha |
| Jurnal tuzatish so'rovi | `high` | ha |
| Yangi xabar | `normal` | ha |
| Reys tayinlandi | `normal` | ha |
| Hisobot tayyor | `normal` | yo'q |

**Push yuki** — faqat identifikator, maxfiy ma'lumot emas:
```json
{ "type": "violation", "id": "vio_...", "driverId": "drv_..." }
```
Ilova ochilganda REST orqali to'liq ma'lumotni oladi.

**FCM tokenlar `PushToken` jadvalida** (5.3), `Driver.fcmToken` da emas. Sabab: bitta drayverda **telefon va planshet** bir vaqtda bo'ladi — bitta ustun ikkinchi qurilmani jimgina o'chirib yuborardi va drayver planshetda bildirishnoma olmasdi.

| Amal | Endpoint | Natija |
|---|---|---|
| Login yoki token yangilanishi | `POST /mobile/push-tokens` `{ token, platform, deviceLabel }` | Upsert (`token` unique) |
| Logout | `DELETE /mobile/push-tokens/:token` | Faqat **shu qurilmaning** tokeni o'chadi |
| FCM `UNREGISTERED` qaytarsa | — | Token avtomatik o'chiriladi |
| 60 kun ishlatilmagan token | `retention.processor` | O'chiriladi |

Push yuborilganda drayverning **barcha faol tokenlariga** ketadi.

---

## 13. Offline ish — mobil va planshet

> **Talab:** drayver ilovasi internetsiz **to'liq** ishlaydi. Bu qulaylik emas — FMCSA talabi. Aloqa yo'q joyda ham drayver soatlarini ko'rishi, statusni o'zgartirishi, DVIR topshirishi va inspektorga jurnalni ko'rsatishi shart.

### 13.1. Uch bosqichli navbat

```
PT30 xotirasi  →  Ilova SQLite  →  Server PostgreSQL
   (30 kun)        (cheksiz)         (doimiy)
```

Har bosqich mustaqil ishlaydi. Bittasi uzilsa, boshqasi ma'lumotni saqlab turadi.

### 13.2. Offline'da nima ishlaydi

| Funksiya | Offline | Izoh |
|---|---|---|
| HOS soatlari (jonli) | ✅ | Lokal dvigatel hisoblaydi (8.6) |
| Duty status o'zgartirish | ✅ | Navbatga tushadi |
| PC / YM yoqish | ✅ | |
| Oxirgi **8 kunlik** jurnal ko'rish | ✅ | Lokal saqlanadi |
| Jurnalni sertifikatlash | ✅ | Imzo lokal saqlanadi |
| DVIR to'ldirish + rasm | ✅ | Rasm navbatda turadi |
| **DOT inspeksiya rejimi** | ✅ | Majburiy — 13.5 |
| **Output fayl generatsiyasi** | ✅ | Lokalda yasaladi |
| Trip ma'lumotini ko'rish | ✅ | Oxirgi sinxronlangan holat |
| Xabar yozish | ✅ | Navbatga tushadi |
| Xabar olish | ❌ | Internet kerak |
| Jurnal tuzatishini qabul qilish | ❌ | Internet kerak |
| Hisobot generatsiyasi | ❌ | Serverda bajariladi |

### 13.3. Lokal saqlash hajmi

| Ma'lumot | Saqlash muddati | Taxminiy hajm |
|---|---|---|
| ELD hodisalari | **30 kun** | ~8 MB |
| Telemetriya (downsampled) | 3 kun | ~4 MB |
| Kunlik jurnallar | 30 kun | ~1 MB |
| DVIR + rasmlar | yuborilgunicha | ~25 MB |
| Xabarlar | 30 kun | ~2 MB |
| Ma'lumotnomalar (unitlar, drayverlar) | doimiy | ~1 MB |

Navbat 30 kundan oshsa yoki 200 MB'ga yetsa → drayverga ogohlantirish va `alert.sync_backlog` serverga (aloqa tiklanganda).

### 13.4. Sinxronizatsiya protokoli

```
POST /v1/mobile/sync
{
  "lastSyncAt": "2025-09-10T14:00:00Z",
  "hosEngineVersion": "1.4.0",
  "changes": [
    { "type": "duty_status", "clientId": "uuid", "payload": {...}, "occurredAt": "..." }
  ]
}
```

```json
{
  "accepted": ["uuid1"],
  "rejected": [{ "clientId": "uuid3", "code": "DRIVING_TIME_IMMUTABLE" }],
  "serverChanges": [ ... ],
  "serverTime": "2025-09-10T15:41:00Z",
  "hosEngineVersion": "1.4.0",
  "nextSyncAfterSec": 60
}
```

**Yuborish tartibi:**
- Aloqa bor: har **60 sekundda** yoki navbatda 50 ta o'zgarish to'planganda
- Aloqa yo'q: eksponensial backoff `30s → 1m → 5m → 15m → 30m` (maksimum)
- Ilova ochilganda va fondan qaytganda — darhol
- Batch: maksimum 500 o'zgarish, 1 MB

**Retry:** `5xx` va tarmoq xatolarida qayta urinadi. `4xx` da qayta urinmaydi — o'zgarish `rejected` deb belgilanadi va drayverga ko'rsatiladi.

### 13.5. ⚠️ DOT inspeksiyasi offline'da

Bu eng kritik ssenariy: inspektor yo'lda to'xtatadi, u yerda aloqa yo'q.

**Majburiy talablar:**

1. Oxirgi **8 kunlik** to'liq jurnal ilovada saqlanadi (grafik + hodisalar + sertifikatlash holati)
2. **Inspeksiya rejimi** internetsiz ochiladi va faqat o'qish uchun ma'lumot ko'rsatadi
3. **Output fayl (CSV) ilovada generatsiya qilinadi** — serverga murojaat qilmasdan
4. Uzatish urinishi:
   - Internet bor → server orqali (`POST /v1/transfers`)
   - Internet yo'q → fayl **qurilmada** saqlanadi, ekranda: *"Aloqa yo'q. Inspektorga ekrandagi jurnalni ko'rsating."*
   - Aloqa tiklanganda navbatdagi uzatish avtomatik yuboriladi
5. Ekrandagi jurnalni ko'rsatish FMCSA tomonidan **qonuniy** deb qabul qilinadi — ilova buni drayverga aniq aytadi

### 13.6. Nizolarni hal qilish

| Holat | Qoida |
|---|---|
| Bir xil `clientId` ikki marta | Idempotent — birinchisi qoladi |
| Offline status vs server tuzatish so'rovi | **Drayver yozuvi ustun** — u haqiqatni ko'rgan |
| Qurilma vaqti orqaga ketgan | Server vaqti ustun, `T` malfunction yoziladi |
| DVIR rasmi yuklanmagan | Metadata qabul qilinadi, rasm keyin `PUT /uploads/:id` |
| Ikki qurilmadan bir xil drayver | Oxirgi `occurredAt` yutadi, ikkalasi ham audit'ga yoziladi |
| Lokal va server HOS farq qilyapti | Server haqiqat manbai, lekin farq > 60 sek bo'lsa `alert.hos_engine_drift` |

### 13.7. Foydalanuvchiga ko'rsatish

Ilova holatni **yashirmaydi** — drayver nima bo'layotganini bilishi kerak:

| Holat | UI |
|---|---|
| Hammasi sinxron | Belgisiz (shovqin qilmaydi) |
| Navbatda N ta o'zgarish | Yuqorida kulrang chiziq: *"12 ta yozuv yuborilmagan"* |
| Offline | Qora banner: *"Aloqa yo'q — yozuvlar qurilmada saqlanmoqda"* (`T16` ekranida chizilgan) |
| Sinxronlash ketyapti | Aylanuvchi indikator |
| Rad etilgan o'zgarish | Qizil banner + sabab |

---

## 14. Bildirishnomalar

**Kanallar:** `IN_APP` · `EMAIL` · `WEBHOOK`

**SMS — v1 da yo'q.** Ilgari TZ da «`SMS` enum'da qoladi, `NotificationService` uni email'ga yo'naltiradi» deyilgan edi. Bu Figma bilan zid: UI da SMS kanali **o'chirilgan va "v2 · coming soon"** deb belgilangan, ya'ni foydalanuvchi uni tanlay olmaydi. API esa uni jimgina qabul qilib email yuborardi — foydalanuvchi SMS ketdi deb o'ylardi.

To'g'ri xatti-harakat:

| Qatlam | Qoida |
|---|---|
| Enum | `SMS` **qoladi** — v2 da migratsiyasiz qo'shish uchun |
| API validatsiya | `channels` ichida `SMS` bo'lsa → **`422 CHANNEL_NOT_AVAILABLE`** (`{ channel: "SMS", availableIn: "v2" }`) |
| Seed qoidalar | Hech bir standart qoidada `SMS` yo'q |
| UI | Kanal o'chirilgan, yonida "v2 · coming soon" belgisi |
| Migratsiya | Twilio qo'shilganda faqat adapter va validatsiyadan chiqarish |

```ts
interface AlertRule {
  id: string; name: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  conditions: Condition[];
  channels: ('IN_APP' | 'EMAIL' | 'SMS' | 'WEBHOOK')[];
  recipients: RecipientSelector;
  throttle: { perDriverPerDay?: number; cooldownMin?: number };
  quietHours?: { from: string; to: string; timezone: string };
  enabled: boolean;
}
```

**Standart qoidalar (seed):**

| Qoida | Shart | Kanallar |
|---|---|---|
| HOS violation | har qanday buzilish | in-app, email |
| Break required soon | tanaffusgacha < 30 daq | in-app, email |
| ELD disconnected | BLE 30 daq+ uzilgan | in-app, email |
| Device backlog | storedEventsCount > 100 | in-app, email |
| Unassigned driving | segment > threshold | in-app, email |
| Odometer anomaly | orqaga ketdi yoki 2000 mi+ sakradi | in-app, email |
| Speeding | limit +10 mph, 60 sek | in-app |
| Maintenance overdue | muddat o'tgan | email |
| Uncertified logs | **8 kundan** ortiq (9.2 bilan bir xil) | email |

**Email provayderi:** SMTP (server pochtasi) yoki Firebase orqali. Shablon `notifications/templates/`.

---

## 15. Hisobotlar

Hisobot **hech qachon so'rov ichida** generatsiya qilinmaydi:

```
POST /reports/generate → 202 { reportId, status: "QUEUED" }
GET  /reports/:id      → { status: "READY", downloadUrl, expiresAt }
WS   report.ready
```

- **Streaming** — millionlab qatorni xotiraga o'qish taqiqlanadi
- Fayl S3'ga, presigned URL 7 kun, 24 oy saqlanadi
- PDF: Puppeteer, shablon `reports/templates/`
- CSV: `fast-csv` streaming

**IFTA:** telemetriya nuqtalari shtat chegaralari bilan kesishtiriladi → `IftaSegment`. Yoqilg'i `FuelPurchase` dan.

> ⚠️ **Saqlash muddati.** Telemetriya 13 oydan keyin o'chiriladi, IFTA auditi esa **4 yil**lik yozuvlarni so'raydi. Shuning uchun:
> - `IftaSegment` **har kuni kechasi** hisoblanadi (telemetriya hali bor paytda), oyning oxirini kutmaydi
> - `IftaSegment` va `FuelPurchase` **4 yil** saqlanadi va `retention.processor` ularga tegmaydi
> - Chorak yopilgach segmentlar `locked = true` bo'ladi va qayta hisoblanmaydi

---

## 16. Integratsiyalar

| Integratsiya | Yo'nalish | Izoh |
|---|---|---|
| **Pacific Track SDK** | ilova ichida | Backend'da emas — Flutter tomonda |
| **Firebase Auth** | inbound | Google Sign-In tokenini tekshirish |
| **McLeod / TMS** | ikki tomonlama | reys import, holat eksport |
| **WEX / Comdata** | inbound | yoqilg'i xaridlari, IFTA uchun |
| **QuickBooks** | outbound | settlement eksport |
| **Slack** | outbound | alert kanali |
| **Webhook** | outbound | HMAC-SHA256, 3 retry (1s, 10s, 60s) |

```
X-OneBook-Signature: t=1789000000,v1=<hmac_sha256(secret, "t.body")>
```

---

## 17. Fayl saqlash

| Tur | Yo'l | Cheklov |
|---|---|---|
| DVIR rasmi | `dvir/{dvirId}/{uuid}.jpg` | 5 MB, maks 5 ta |
| Imzo | `signatures/{driverId}/{uuid}.png` | 500 KB |
| Hisobot | `reports/{reportId}.{ext}` | — |
| Transfer fayli | `transfers/{transferId}.csv` | 24 oy |
| Logo | `branding/logo.png` | 2 MB |

Yuklash presigned PUT orqali · rasm 1600px ga qisqartiriladi, EXIF tozalanadi · barcha fayllar private, presigned GET 15 daqiqa.

---

## 18. Audit jurnali

```ts
@Audit({ object: 'Driver', action: 'UPDATE' })
```

```prisma
model AuditLog {
  id         BigInt   @id @default(autoincrement())
  actorId    String
  actorType  EditorType
  action     String
  objectType String
  objectId   String
  before     Json?
  after      Json?
  detail     String?
  ip         String?
  userAgent  String?
  createdAt  DateTime @default(now())

  @@index([createdAt])
  @@index([objectType, objectId])
}
```

**Majburiy:** rol o'zgarishi · jurnal tuzatishi · sertifikatlash · unit o'chirish · odometr kalibrlash · ma'lumot uzatish · hisobot eksporti · foydalanuvchi taklifnomasi · carrier sozlamasi.

```sql
REVOKE UPDATE, DELETE ON "AuditLog" FROM app_user;
REVOKE UPDATE, DELETE ON "EldEvent" FROM app_user;
```

---

## 19. Performance

| Ko'rsatkich | Maqsad |
|---|---|
| API p95 | < 200 ms |
| `/live/fleet` (300 unit) | < 250 ms |
| Ingest — hodisa | **50 hodisa/sek** barqaror, **300/sek** pik (BLE tiklanganda to'p-to'p keladi) |
| Ingest — telemetriya | 100 nuqta/sek |
| HOS recalc (1 kun) | < 150 ms |
| HOS recalc (8 kun) | < 800 ms |
| WebSocket ulanishlar | 500 |
| Hisobot (250 drayver, 8 kun) | < 45 sek |

**Qoidalar:** N+1 taqiqlanadi · Redis kesh (carrier 5 daq, rollar 5 daq, live fleet 10 sek) · cursor pagination · oylik partition · Prisma `connection_limit=20`.

---

## 20. Xatolik formati

```json
{
  "statusCode": 422,
  "code": "DRIVING_TIME_IMMUTABLE",
  "message": "Haydash vaqtini qisqartirib bo'lmaydi (49 CFR §395.30).",
  "details": { "eventId": "12345" },
  "traceId": "01J8X...",
  "timestamp": "2025-09-10T15:41:00Z"
}
```

Kodlar registri `common/errors/codes.ts`. O'zgartirilmaydi.

---

## 21. Testlash

| Daraja | Qamrov | Vosita |
|---|---|---|
| Unit — `hos/` | **≥ 95%** | Jest |
| Unit — `common/units/` | **100%** | Jest |
| Unit — boshqa | ≥ 80% | Jest |
| **Conformance — HOS (TS va Dart)** | **100%** | umumiy JSON fikstyuralar (8.6) |
| Integration — repository | asosiy so'rovlar | **dev DB** (22.3) |
| E2E — endpointlar | 100% happy + auth rad | Supertest |
| Contract — mobil sync | to'liq | snapshot |
| **Real-time — resume/uzilish** | to'liq | soket sinov mijozi |
| **Offline — 30 kunlik navbat** | to'liq | ilova integratsiya testi |
| Load — ingest, live fleet, WS | maqsadli raqamlar | k6 |

**CI darvozasi:** `hos/` qamrovi 95% dan tushsa yoki **conformance testlaridan bittasi tushsa** — build qulaydi. Bu ikkala repoda ham (backend va mobil) amal qiladi.

**Real-time sinov ssenariylari:**
- 15 daqiqadan kam uzilish → `resume` yo'qolgan hodisalarni qaytaradi
- 15 daqiqadan ko'p uzilish → `truncated: true`, mijoz to'liq qayta yuklaydi
- Token muddati tugashi → ulanish uzilmasdan yangilanadi
- WebSocket bloklangan → polling'ga tushadi

**Offline sinov ssenariylari:**
- 30 kun aloqasiz ishlash → navbat to'g'ri saqlanadi va tiklanadi
- Offline DOT inspeksiyasi → output fayl qurilmada generatsiya qilinadi
- Ikki qurilmadan bir xil drayver → nizo qoidasi bo'yicha hal bo'ladi
- Lokal va server HOS natijasi → 60 sekunddan kam farq

---

## 22. Deploy va ma'lumotlar bazasi

### 22.1. Muhitlar

Kod **serverda yoziladi** (buyurtmachi qarori). Shuning uchun dev va prod bitta mashinada yashaydi, lekin **qat'iy ajratilgan**.

| | Dev | Prod |
|---|---|---|
| DB nomi | `onebook_eld_dev` | `onebook_eld` |
| DB foydalanuvchi | `eld_dev` | `eld_prod` |
| Redis DB raqami | `1` | `0` |
| S3 bucket | `onebook-dev` | `onebook-prod` |
| API port | `3001` | `3000` |
| Env fayl | `.env.development` | `.env.production` |

### 22.2. Konteynerlar

```yaml
services:
  api:        # NestJS, port 3000
  worker:     # BullMQ
  api-dev:    # NestJS watch rejimi, port 3001
  postgres:   # 16 — ikkala DB shu yerda
  redis:      # ikkala muhit, turli DB raqami
  minio:      # ikkala bucket
```

Reverse proxy — **Caddy** (repoda allaqachon bor).

### 22.3. ⭐ Dev DB = prod DB nusxasi

> **Talab:** dev rejimida prod bilan **bir xil tuzilmadagi** alohida DB ishlatiladi.

**Qoidalar:**

1. **Sxema aynan bir xil.** Ikkala DB'ga **bir xil migratsiyalar** qo'llanadi. Farq bo'lishi taqiqlanadi.

2. **Ma'lumot alohida.** Dev DB'da faqat seed va test ma'lumoti bo'ladi. Prod ma'lumoti dev'ga **ko'chirilmaydi** (drayverlarning shaxsiy ma'lumoti va HOS jurnallari).

3. **Migratsiya oqimi qat'iy:**
   ```
   1) dev'da yaratish:      npx prisma migrate dev --name add_x
   2) dev'da tekshirish:    npm run test:integration
   3) prod'ga qo'llash:     npx prisma migrate deploy   (prod DSN bilan)
   ```
   Prod'da **hech qachon** `migrate dev` ishlatilmaydi — u ma'lumotni o'chirishi mumkin.

4. **Ulanish himoyasi — ikki tomonlama.** Ilgari tekshiruv faqat bitta yo'nalishni (dev → prod DB) ushlardi va u ham `NODE_ENV !== 'production'` shartiga bog'liq edi — ya'ni `NODE_ENV=production` qo'yib qo'yilsa himoya butunlay o'chardi.

   ```ts
   // core/config/db-guard.ts — AppModule ishga tushishida, o'chirilmaydi
   const url = new URL(config.DATABASE_URL);
   const db  = url.pathname.slice(1);          // "onebook_eld" | "onebook_eld_dev"
   const isProdDb  = db === 'onebook_eld';
   const isDevDb   = db === 'onebook_eld_dev';
   const isProdEnv = config.NODE_ENV === 'production';

   if (!isProdDb && !isDevDb)
     throw new Error(`XAVFLI: noma'lum DB nomi "${db}"`);
   if (!isProdEnv && isProdDb)
     throw new Error('XAVFLI: dev rejimi PROD DB ga ulanmoqda!');
   if (isProdEnv && isDevDb)
     throw new Error('XAVFLI: prod rejimi DEV DB ga ulanmoqda!');
   if (isProdEnv && url.username !== 'eld_prod')
     throw new Error('XAVFLI: prod noto\'g\'ri DB foydalanuvchisi bilan ulanmoqda!');
   ```

   **Resurs ajratish.** Dev va prod bitta Postgres va bitta Redis instansiyasida yashaydi, shuning uchun dev prodni cho'ktirib qo'ymasligi kerak:

   | Chora | Qiymat |
   |---|---|
   | `eld_dev` uchun `CONNECTION LIMIT` | 10 (prod 40) |
   | `eld_dev` uchun `statement_timeout` | 30 sek (prod 60 sek) |
   | Redis | dev DB `1`, prod DB `0`; `maxmemory-policy` prod uchun `noeviction` |
   | Konteyner limitlari | `api-dev` uchun CPU 1, RAM 1 GB |

   ```sql
   ALTER ROLE eld_dev CONNECTION LIMIT 10;
   ALTER ROLE eld_dev SET statement_timeout = '30s';
   REVOKE ALL ON DATABASE onebook_eld FROM eld_dev;   -- dev prod DB ni ko'rmaydi
   ```

5. **Sxema drift nazorati.** Har kuni kechasi cron:
   ```bash
   npm run db:check-drift    # dev va prod sxemalarini solishtiradi
   ```
   Farq topilsa — email ogohlantirish.

6. **Seed ma'lumoti = Figma demo ma'lumoti.**

   ⚠️ **Sana nisbiy bo'ladi.** Figmada ma'lumot `Wed, Sep 10, 2025 · 15:41 ET` uchun chizilgan. Agar seed shu sanani qat'iy yozsa, bir oydan keyin «bugungi jurnal» eskirgan bo'ladi va HOS ekranlari bo'sh chiqadi.

   ```
   ANCHOR = bugungi kun, 15:41 (driver.homeTerminalTimezone)
   Barcha hodisa va jurnal vaqtlari ANCHOR ga nisbatan yasaladi:
     SB   ANCHOR-15:41  →  ANCHOR-13:41
     ON   ANCHOR-13:41  →  ANCHOR-13:11
     D    ANCHOR-13:11  →  ANCHOR-07:41
     OFF  ANCHOR-07:41  →  ANCHOR-07:11   (30 daq tanaffus)
     D    ANCHOR-07:11  →  ANCHOR-01:15   (11:26 jami → limit oshdi)
     ON   ANCHOR-01:15  →  ANCHOR+01:19
   Oldingi 7 kun ham shu tarzda orqaga yasaladi.
   ```

   `SEED_ANCHOR_DATE` env o'zgaruvchisi berilsa — o'sha sana ishlatiladi (test va skrinshot uchun).

   `prisma/seed.ts` Figmadagi aynan o'sha ma'lumotni yaratadi:
   - Carrier: Universal Logistics Inc., DOT #1234567
   - 4 ta rol, 12 ta foydalanuvchi (Sarah Chen admin)
   - 69 ta unit (#101 Freightliner Cascadia, VIN 1FUJGLDR8LLLL1234, ...)
   - 58 ta drayver (John Smith @johnsmith, Unit #101, CDL OH-W8569238, home terminal Columbus OH / `America/New_York`)
   - PT30 qurilmalari (PT30_A86E firmware L113, PT30_EE35, PT30_C41B L108, ...) — BLE holati va `storedEventsCount` bilan
   - John Smith uchun 8 kunlik to'liq HOS jurnali — **11:26 haydash, ANCHOR−01:15 da 11-soatlik limit oshgan (00:26 ga)**
   - `CoDriverPairing`: John Smith ↔ **Marcus Webb**, unit #101 (William Bond emas — u #104 ni haydayapti)
   - DVIR'lar: `#88214` Sep 10 pre-trip no defects · `#88208` Sep 08 post-trip, defektlar **tuzatilgan**
   - Unit **#110** — `OUT_OF_SERVICE` (kritik tormoz defekti, `WO-2214`)
   - Reyslar (`TR-4821`), xabarlar, bildirishnomalar

   Shunda frontend va backend bir xil ma'lumot ustida ishlaydi va dizaynga aniq mos keladi.

7. **Dev DB'ni tiklash:**
   ```bash
   npm run db:reset:dev   # drop → migrate → seed
   ```
   Bu buyruq prod DSN bilan ishga tushmasligi uchun `NODE_ENV=production` da xato beradi.

### 22.4. Backup

- `pg_dump` har kuni (faqat prod DB) + WAL arxivi, PITR 7 kun
- Backup **boshqa serverga** ko'chiriladi
- Oyiga bir marta **tiklash mashqi** o'tkaziladi va natija yozib boriladi

### 22.5. Monitoring

- Loglar: pino → JSON, `traceId`
- Metrikalar: Prometheus `/metrics`
- Xatoliklar: Sentry (dev va prod alohida loyiha)
- Health: `/health/live` · `/health/ready` · `/health/deep`
- Alert: ingest lag > 5 daq · HOS navbati > 500 · p95 > 500 ms · disk > 80% · sxema drift

---

## 23. Muvofiqlik cheklisti

- [ ] Haydash vaqti hech qanday yo'l bilan qisqartirilmaydi
- [ ] `EldEvent` va `AuditLog` append-only (DB darajasida `REVOKE`)
- [ ] Har bir hodisada checksum bor va tekshiriladi
- [ ] Tuzatish faqat taklif; drayver tasdig'isiz kuchga kirmaydi
- [ ] Sertifikatlash har o'zgarishdan keyin qaytadan talab qilinadi
- [ ] Qurilmada saqlangan hodisalar yo'qotilmaydi va unidentified sifatida qayd etiladi
- [ ] Malfunction/diagnostic avtomatik aniqlanadi
- [ ] Output fayl formati Appendix A ga mos (TEST rejimida ham)
- [ ] Email uzatish faqat `fmcsa.dot.gov` domeniga
- [ ] RODS 6 oy, audit 24 oy saqlanadi
- [ ] Joylashuv aniqligi: on-duty 1 milya, PC 10 milya
- [ ] Barcha vaqtlar UTC saqlanadi, ko'rsatishda kompaniya mintaqasiga o'giriladi
- [ ] DST o'tishida kun 23 yoki 25 soat bo'lishi to'g'ri hisoblanadi
- [ ] Odometr offseti to'g'ri qo'llanadi va kalibrlash audit qilinadi
- [ ] Metrik → imperial konvertatsiya 100% test bilan qoplangan
- [ ] Split sleeper: **ikkala** kvalifikatsiyalangan qism ham 14 soatlik oynadan chiqariladi
- [ ] Unidentified biriktirilganda `recordOrigin` **1 bo'lib qoladi**, 2 ga o'zgartirilmaydi
- [ ] Har hodisada `eventSequenceId` bor, bir marta beriladi va o'zgarmaydi
- [ ] PC joylashuvi 10 milyagacha **saqlashdan oldin** qo'pollashtiriladi
- [ ] RODS kuni `driver.homeTerminalTimezone` bo'yicha bo'linadi
- [ ] Output fayl nomi Appendix A 4.8.2.2 bo'yicha, unit test bilan qoplangan
- [ ] `eldIdentifier` — aynan 6 belgi (7.15), `eldRegistrationId` — aynan 4 belgi (7.17)
- [ ] Email uzatish shifrlangan va faqat `fmcsa.dot.gov` domeniga
- [ ] ~~Google Sign-In 2FA ni chetlab o'tmaydi~~ — 2FA butunlay olib tashlandi (D-050), band emas
- [ ] Dart va TypeScript dvigatellari umumiy fikstyuralarda 100% mos
- [ ] Qayta hisoblash buzilish yozuvlarini ko'paytirmaydi (`upsert` + `AUTO_CLEARED`)
- [ ] Drayver o'z jurnalini tuzata oladi, lekin `D` segmentiga tegolmaydi

---

## 24. Bosqichlar

| # | Bosqich | Tarkib | Natija |
|---|---|---|---|
| **1** | Poydevor | Nest skeleton, Prisma, **dev+prod DB**, seed, auth (parol + Google), rollar, audit | Login ishlaydi, seed ma'lumoti Figmaga mos |
| **2** | Fleet | Vehicles, Drivers, Devices, odometer kalibrlash, import/export | Fleet bo'limlari to'liq |
| **3** | Ingest | `/ingest/*`, birliklar konvertatsiyasi, BLE holati, stored events, partition | Ilovadan ma'lumot oqadi |
| **4** | ⭐ HOS dvigateli (TS) | Qoidalar, 300 test, recalc job, violations, **`backend/test/conformance/golden/` fikstyuralari yoziladi** | Soatlar serverda to'g'ri |
| **4b** | ⭐ HOS dvigateli (Dart) | Ayni spetsifikatsiyadan `lib/hos/engine/`, **o'sha JSON fikstyuralar bilan 100% conformance**, `HOS_ENGINE_VERSION` ikkala tomonda bir xil, `POST /mobile/hos-state` va tungi drift solishtiruvi | Soatlar offline'da ham to'g'ri |
| **5** | RODS | Kunlik jurnal, tuzatish, sertifikatlash, unidentified | HOS Logs to'liq |
| **6** | Mobil API | bootstrap, sync, duty-status, DVIR, imzo | Drayver ilovasi ishlaydi |
| **7** | DVIR va xizmat | Defektlar, ish buyurtmalari, jadval, DTC | DVIR ekranlari to'liq |
| **8** | Hisobotlar | IFTA, Activity, DVIR, FMCSA paketi, scheduler | Reports to'liq |
| **9** | eRODS (TEST) | Output fayl, validatsiya, yuklab olish | Fayl to'g'ri chiqadi |
| **10** | Operatsiya | Trips, Safety, Geofences, Messaging, Alerts | Dispatch va Safety to'liq |
| **11** | Sozlama | Carrier, Integrations, API keys, Support | Settings to'liq |
| **12** | Qattiqlashtirish | Load test, xavfsizlik, monitoring, backup mashqi, **HOS drift 7 kun kuzatuv** | Prod'ga tayyor |

> **4b bosqichi tashlab ketilmaydi.** 8.6-bo'lim uni «eng katta muvofiqlik xavfi» deb ataydi, lekin oldingi versiyada bosqichlar jadvalida umuman yo'q edi — ya'ni rejalashtirilmagan ish edi. Dart dvigateli 6-bosqichdan (Mobil API) **oldin** tayyor bo'lishi kerak, aks holda ilova server javobini kutib qoladi va offline talab buziladi.

---

## 25. Qabul qilish mezonlari

1. Barcha endpointlar Swagger'da, misol javoblari bilan
2. E2E testlar yashil, qamrov talabi bajarilgan
3. `hos/` o'zgargan bo'lsa — golden testlar yashil
4. Migratsiya `up` va `down` **dev DB'da** sinovdan o'tgan
5. Dev va prod sxemalari **aynan bir xil** (`db:check-drift` toza)
6. Yangi endpoint kamida bitta Figma ekraniga bog'langan
7. Muvofiqlik cheklistidagi tegishli bandlar belgilangan
8. p95 maqsaddan oshmagan (k6 hisoboti)
9. Har bir rol bo'yicha ruxsat testi yozilgan

---

## 26. Hal qilingan savollar

| # | Savol | Javob |
|---|---|---|
| 1 | PT30 payload formati | `eld.docs/pt30_docs/` — BLE arxitekturasi 3-bo'limda hisobga olindi |
| 2 | eRODS sertifikati | **TEST rejimi**. Prod'ga o'tish faqat sozlama (10.1) |
| 3 | SMS provayderi | Hozircha **email**. Kelajakda SMS adapteri qo'shiladi (14-bo'lim) |
| 4 | Hosting | Kod **serverda yoziladi**, dev va prod bitta mashinada (22-bo'lim) |
| 5 | SAML | Kerak emas. **Email + parol + 2FA** va **Google Sign-In (Firebase)** |
| 6 | Terminal scoping | Hozircha **bitta baza** — scoping yo'q |
| 7 | Ma'lumot rezidentligi | Buyurtmachi hal qiladi |

**Qolgan aniqlik talab qiladigan narsalar:**

| # | Savol | Kimga tegishli | Ta'siri |
|---|---|---|---|
| 1 | Pacific Track SDK'ning Flutter wrapper'i bor-yo'qligi (SDK Android/iOS native) | Mobil ilova | Backend'ga ta'sir qilmaydi |
| 2 | Output fayl nomi formati (10.2) FMCSA hujjatining **joriy** nashri bo'yicha yakuniy tekshirilsin | Backend | Fayl nomi noto'g'ri bo'lsa eRODS faylni rad etadi. Generator alohida funksiya, tuzatish 1 soatlik ish |
| 3 | FMCSA email shifrlash uchun ochiq kalit va mavzu qatori formati (10.4) | Backend | TEST rejimida to'sqinlik qilmaydi, PRODUCTION'ga o'tishda kerak |
| 4 | 8-kunlik `previousDays` ni birinchi ishga tushirishda qayerdan olish (tarixiy ma'lumot yo'q) | Backend | Birinchi 8 kun cycle noto'g'ri ko'rinadi. Yechim: migratsiya paytida qo'lda kiritish formasi |

---

## 27. Kelajakda SaaS'ga o'tish

> Hozir kerak emas, lekin o'tish **qayta yozish emas, migratsiya** bo'lsin.

### 27.1. Hozir qilinadigan "sug'urta" (xarajatsiz)

1. Barcha DB murojaatlari `BaseRepository` orqali
2. `Carrier` — jadval, env emas
3. `RequestContext` har so'rovda mavjud
4. Barcha ID — UUID (`EldEvent.id` dan tashqari)
5. Fayl yo'llari prefiks qo'shishga tayyor

### 27.2. O'tish paytidagi ish

| Qadam | Hajmi |
|---|---|
| `Carrier` singleton constraint'ini olib tashlash | 1 migratsiya |
| ~30 jadvalga `carrierId` + backfill | 1 migratsiya, ~1 soat |
| Indekslarni `(carrierId, ...)` ga o'zgartirish | 1 migratsiya |
| `BaseRepository`ga filtr | ~50 qator |
| JWT'ga `tid`, `TenantGuard` | ~150 qator |
| Billing moduli | yangi modul |

**Baho:** 2–3 hafta (27.1 ga rioya qilinsa), aks holda 2–3 oy.

### 27.3. Nima qilmaslik kerak

- Hozir `carrierId` ustunlarini qo'shib qo'ymang — bo'sh yuk
- Row-Level Security sozlamang
- Schema-per-tenant haqida o'ylamang
