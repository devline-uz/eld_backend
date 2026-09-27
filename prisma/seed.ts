/**
 * OneBook ELD — dev DB seed (tz.md §22.3.6).
 *
 * Reproduces the Figma demo dataset (Universal Logistics Inc.) with dates ANCHOR-relative
 * so the "today" screens never look stale. Idempotent: re-running `npm run db:seed` upserts
 * the same rows instead of duplicating them.
 *
 * ANCHOR = today 15:41 in the reference home-terminal timezone (America/New_York),
 * overridable with SEED_ANCHOR_DATE (e.g. "2025-09-10") for reproducible screenshots/tests.
 *
 * NOTE on password/PIN hashing: uses the real Argon2id scheme from `modules/auth`
 * (tz §6.5 — memoryCost=19456, timeCost=2, parallelism=1), the same function the login
 * endpoints verify against, so the seeded demo accounts (password `Onebook2026`) work
 * end-to-end through `POST /auth/login` and `POST /auth/login/driver`.
 */
import { DateTime } from 'luxon';
import {
  PrismaClient,
  AuthProvider,
  UserStatus,
  DriverStatus,
  VehicleStatus,
  DeviceStatus,
  DeviceModel,
  BleState,
  FuelType,
  DvirType,
  DvirCondition,
  RepairStatus,
  DefectPart,
  DefectSeverity,
  DefectStatus,
  WorkOrderStatus,
  WorkOrderPriority,
  TripStatus,
  ConversationType,
  EditorType,
} from '@prisma/client';
import { hashPassword } from '../src/modules/auth/lib/password.util';
import { coarsenLocation } from '../src/common/units/location';
import { seedFixTime } from '../src/modules/live/live-fleet.seed';

const prisma = new PrismaClient();

const HOME_TZ = 'America/New_York';
// Populated at the top of main() — Argon2id hashing is async, unlike the old placeholder.
let DEMO_PASSWORD_HASH = '';
let DEMO_PIN_HASH = '';

/** ANCHOR = today 15:41 in HOME_TZ, or SEED_ANCHOR_DATE (date-only) at 15:41. */
function computeAnchor(): DateTime {
  const override = process.env.SEED_ANCHOR_DATE?.trim();
  const base = override ? DateTime.fromISO(override, { zone: HOME_TZ }) : DateTime.now().setZone(HOME_TZ);
  if (!base.isValid) {
    throw new Error(`SEED_ANCHOR_DATE is not a valid date: "${override}"`);
  }
  return base.set({ hour: 15, minute: 41, second: 0, millisecond: 0 });
}

const ANCHOR = computeAnchor();

/** ANCHOR minus H hours and M minutes (tz.md §22.3.6 notation "ANCHOR-13:41" etc). */
function anchorMinus(hh: number, mm: number): DateTime {
  return ANCHOR.minus({ hours: hh, minutes: mm });
}
function anchorPlus(hh: number, mm: number): DateTime {
  return ANCHOR.plus({ hours: hh, minutes: mm });
}

// ---------------------------------------------------------------------------
// Permission matrix — tz.md §6.4 (22 keys x 4 roles).
// ---------------------------------------------------------------------------

type PermissionLevel = 'NONE' | 'READ' | 'FULL';
// B-95 — `dataTransfer` is an additive 23rd key split from `reportsTransfer`
// (src/common/decorators/permission.types.ts); ADMIN's `Object.fromEntries` below gives it
// FULL automatically, the other three roles are listed explicitly.
const PERMISSION_KEYS = [
  'dashboard', 'liveFleet', 'vehicles', 'drivers', 'hos', 'hosEdit',
  'hosCertifyOnBehalf', 'dvir', 'maintenance', 'safety', 'trips',
  'reports', 'reportsTransfer', 'messaging', 'devices', 'alertRules',
  'users', 'roles', 'integrations', 'auditLog', 'support', 'carrierSettings',
  'dataTransfer',
] as const;

const ROLE_MATRIX: Record<string, Record<(typeof PERMISSION_KEYS)[number], PermissionLevel>> = {
  ADMIN: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'FULL'])) as Record<
    (typeof PERMISSION_KEYS)[number],
    PermissionLevel
  >,
  FLEET_MANAGER: {
    dashboard: 'FULL', liveFleet: 'FULL', vehicles: 'FULL', drivers: 'FULL', hos: 'FULL',
    hosEdit: 'FULL', hosCertifyOnBehalf: 'NONE', dvir: 'FULL', maintenance: 'FULL',
    safety: 'FULL', trips: 'FULL', reports: 'FULL', reportsTransfer: 'FULL', messaging: 'FULL',
    devices: 'FULL', alertRules: 'FULL', users: 'NONE', roles: 'NONE', integrations: 'NONE',
    auditLog: 'NONE', support: 'FULL', carrierSettings: 'NONE', dataTransfer: 'FULL',
  },
  DISPATCHER: {
    dashboard: 'FULL', liveFleet: 'FULL', vehicles: 'READ', drivers: 'READ', hos: 'READ',
    hosEdit: 'NONE', hosCertifyOnBehalf: 'NONE', dvir: 'READ', maintenance: 'READ',
    safety: 'READ', trips: 'FULL', reports: 'READ', reportsTransfer: 'NONE', messaging: 'FULL',
    devices: 'READ', alertRules: 'NONE', users: 'NONE', roles: 'NONE', integrations: 'NONE',
    auditLog: 'NONE', support: 'FULL', carrierSettings: 'NONE', dataTransfer: 'NONE',
  },
  VIEWER: {
    dashboard: 'READ', liveFleet: 'READ', vehicles: 'READ', drivers: 'READ', hos: 'READ',
    hosEdit: 'NONE', hosCertifyOnBehalf: 'NONE', dvir: 'READ', maintenance: 'READ',
    safety: 'READ', trips: 'NONE', reports: 'READ', reportsTransfer: 'NONE', messaging: 'NONE',
    devices: 'NONE', alertRules: 'NONE', users: 'NONE', roles: 'NONE', integrations: 'NONE',
    auditLog: 'NONE', support: 'READ', carrierSettings: 'NONE', dataTransfer: 'NONE',
  },
};

const FIRST_NAMES = [
  'James', 'Robert', 'Michael', 'David', 'Richard', 'Joseph', 'Thomas', 'Charles', 'Daniel',
  'Matthew', 'Anthony', 'Mark', 'Paul', 'Steven', 'Kevin', 'Brian', 'George', 'Edward',
  'Ronald', 'Timothy', 'Jason', 'Jeffrey', 'Ryan', 'Jacob', 'Gary', 'Nicholas', 'Eric', 'Jonathan',
  'Larry', 'Justin', 'Scott', 'Brandon', 'Frank', 'Gregory', 'Raymond', 'Samuel', 'Patrick',
  'Alexander', 'Jack', 'Dennis', 'Jerry', 'Tyler', 'Aaron', 'Jose', 'Adam', 'Henry', 'Nathan',
  'Douglas', 'Zachary', 'Peter', 'Kyle', 'Walter', 'Harold', 'Carl', 'Jeremy', 'Keith', 'Roger',
];
const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez',
  'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore',
  'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark',
  'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott',
  'Torres', 'Nguyen', 'Hill', 'Flores', 'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera',
  'Campbell', 'Mitchell', 'Carter', 'Roberts', 'Webb',
];
const MAKES: Array<[string, string]> = [
  ['Freightliner', 'Cascadia'],
  ['Kenworth', 'T680'],
  ['Peterbilt', '579'],
  ['Volvo', 'VNL'],
  ['International', 'LT'],
];

async function main(): Promise<void> {
  console.log(`Seeding dev DB — ANCHOR = ${ANCHOR.toISO()} (${HOME_TZ})`);

  // Argon2id (tz §6.5) — computed once, reused for every seeded user/driver password.
  DEMO_PASSWORD_HASH = await hashPassword('Onebook2026');
  DEMO_PIN_HASH = await hashPassword('246810');

  // ---- Carrier (singleton) --------------------------------------------------
  await prisma.carrier.upsert({
    where: { id: 'carrier' },
    create: {
      id: 'carrier',
      name: 'Universal Logistics Inc.',
      dotNumber: '1234567',
      mcNumber: 'MC-987654',
      timezone: HOME_TZ,
      addressLine1: '4821 Freight Way',
      city: 'Columbus',
      state: 'OH',
      zip: '43215',
      phone: '+1-614-555-0110',
      complianceEmail: 'compliance@universal-logistics.example',
      eldIdentifier: 'OBK1',
      erodsMode: 'TEST',
    },
    update: {
      name: 'Universal Logistics Inc.',
      dotNumber: '1234567',
    },
  });

  // ---- Roles ------------------------------------------------------------
  const roleIds: Record<string, string> = {};
  for (const [key, matrix] of Object.entries(ROLE_MATRIX)) {
    const role = await prisma.role.upsert({
      where: { key },
      create: {
        key,
        name: key
          .split('_')
          .map((w) => w[0] + w.slice(1).toLowerCase())
          .join(' '),
        isSystem: key === 'ADMIN',
        permissions: matrix,
      },
      update: { permissions: matrix },
    });
    roleIds[key] = role.id;
  }

  // ---- Users (12, Sarah Chen = admin) ------------------------------------
  const userSeeds: Array<{ email: string; first: string; last: string; role: string; jobTitle: string }> = [
    { email: 'sarah.chen@universal-logistics.example', first: 'Sarah', last: 'Chen', role: 'ADMIN', jobTitle: 'Fleet Administrator' },
    { email: 'mike.torres@universal-logistics.example', first: 'Mike', last: 'Torres', role: 'FLEET_MANAGER', jobTitle: 'Fleet Manager' },
    { email: 'linda.park@universal-logistics.example', first: 'Linda', last: 'Park', role: 'FLEET_MANAGER', jobTitle: 'Fleet Manager' },
    { email: 'carlos.ramirez@universal-logistics.example', first: 'Carlos', last: 'Ramirez', role: 'DISPATCHER', jobTitle: 'Dispatcher' },
    { email: 'amy.nguyen@universal-logistics.example', first: 'Amy', last: 'Nguyen', role: 'DISPATCHER', jobTitle: 'Dispatcher' },
    { email: 'brian.oconnell@universal-logistics.example', first: 'Brian', last: "O'Connell", role: 'DISPATCHER', jobTitle: 'Dispatcher' },
    { email: 'diane.foster@universal-logistics.example', first: 'Diane', last: 'Foster', role: 'VIEWER', jobTitle: 'Safety Analyst' },
    { email: 'kevin.brooks@universal-logistics.example', first: 'Kevin', last: 'Brooks', role: 'VIEWER', jobTitle: 'Accounting' },
    { email: 'natalie.reed@universal-logistics.example', first: 'Natalie', last: 'Reed', role: 'FLEET_MANAGER', jobTitle: 'Fleet Manager' },
    { email: 'tom.walsh@universal-logistics.example', first: 'Tom', last: 'Walsh', role: 'DISPATCHER', jobTitle: 'Dispatcher' },
    { email: 'priya.sharma@universal-logistics.example', first: 'Priya', last: 'Sharma', role: 'VIEWER', jobTitle: 'Compliance Viewer' },
    { email: 'jason.kim@universal-logistics.example', first: 'Jason', last: 'Kim', role: 'ADMIN', jobTitle: 'Ops Administrator' },
  ];
  const users: Record<string, string> = {};
  for (const u of userSeeds) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      create: {
        email: u.email,
        passwordHash: DEMO_PASSWORD_HASH,
        authProvider: AuthProvider.PASSWORD,
        firstName: u.first,
        lastName: u.last,
        jobTitle: u.jobTitle,
        roleId: roleIds[u.role],
        status: UserStatus.ACTIVE,
      },
      update: {
        roleId: roleIds[u.role],
        passwordHash: DEMO_PASSWORD_HASH,
      },
    });
    users[u.email] = user.id;
  }
  const sarahChenId = users['sarah.chen@universal-logistics.example'];

  // ---- Vehicles (69 units) -----------------------------------------------
  const vehicleIds: string[] = [];
  for (let i = 0; i < 69; i++) {
    const unitNumber = String(101 + i);
    const [make, model] = MAKES[i % MAKES.length];
    const vin =
      i === 0
        ? '1FUJGLDR8LLLL1234'
        : `1FUJGLDR${(8000 + i).toString().padStart(4, '0')}LL${(1000 + i).toString().slice(-4)}`;
    const status = unitNumber === '110' ? VehicleStatus.OUT_OF_SERVICE : VehicleStatus.ACTIVE;
    const vehicle = await prisma.vehicle.upsert({
      where: { unitNumber },
      create: {
        unitNumber,
        vin,
        make,
        model,
        year: 2021 + (i % 4),
        licensePlate: `OH-${(10000 + i).toString()}`,
        plateState: 'OH',
        fuelType: FuelType.DIESEL,
        odometerMi: 50_000 + i * 733,
        status,
        activatedAt: ANCHOR.minus({ months: 6 + (i % 12) }).toJSDate(),
      },
      update: { status },
    });
    vehicleIds.push(vehicle.id);
  }
  const unit101Id = vehicleIds[0];
  const unit104Id = vehicleIds[3];
  const unit110Id = vehicleIds[9];

  // ---- Devices (PT30, one per unit for the first several units) ---------
  const deviceSeeds: Array<{ serial: string; firmware: string; vehicleId: string; bleState: BleState; stored: number }> = [
    { serial: 'PT30_A86E', firmware: 'L113', vehicleId: unit101Id, bleState: BleState.CONNECTED, stored: 0 },
    { serial: 'PT30_EE35', firmware: 'L113', vehicleId: unit104Id, bleState: BleState.CONNECTED, stored: 0 },
    { serial: 'PT30_C41B', firmware: 'L108', vehicleId: unit110Id, bleState: BleState.OUT_OF_RANGE, stored: 4 },
  ];
  for (const d of deviceSeeds) {
    await prisma.device.upsert({
      where: { serial: d.serial },
      create: {
        serial: d.serial,
        model: DeviceModel.PT30,
        firmware: d.firmware,
        vehicleId: d.vehicleId,
        status: DeviceStatus.ASSIGNED,
        bleState: d.bleState,
        lastSeenAt: ANCHOR.minus({ minutes: d.stored > 0 ? 45 : 1 }).toJSDate(),
        storedEventsCount: d.stored,
        pairedAt: ANCHOR.minus({ months: 8 }).toJSDate(),
      },
      update: { bleState: d.bleState, storedEventsCount: d.stored },
    });
  }
  // Remaining units each get an unassigned/assigned generic device so the fleet reads realistically.
  const seededDeviceVehicleIds = new Set(deviceSeeds.map((d) => d.vehicleId));
  let genericDeviceCount = 0;
  for (let i = 0; i < vehicleIds.length && genericDeviceCount < 17; i++) {
    const vehicleId = vehicleIds[i];
    if (seededDeviceVehicleIds.has(vehicleId)) continue;
    const serial = `PT30_D${(1000 + i).toString(16).toUpperCase()}`;
    await prisma.device.upsert({
      where: { serial },
      create: {
        serial,
        model: DeviceModel.PT30,
        firmware: 'L113',
        vehicleId,
        status: DeviceStatus.ASSIGNED,
        bleState: BleState.CONNECTED,
        lastSeenAt: ANCHOR.minus({ minutes: 2 }).toJSDate(),
        storedEventsCount: 0,
        pairedAt: ANCHOR.minus({ months: 5 }).toJSDate(),
      },
      update: {},
    });
    genericDeviceCount++;
  }

  // ---- Last-known positions for ELD-equipped units (web/tz.md §20 B-3, D-053) ----
  // `GET /live/fleet` reads the latest TelemetryPoint per vehicle. A fresh DB has none, so the
  // W-01/W-02 map would be empty. One coarse fix per device-equipped unit, written ONLY when the
  // unit has no telemetry at all: idempotent on any day and never shadows real ingested data.
  // Coordinates go through `coarsenLocation` (1 mi) like the ingest path — never a raw fix.
  const SEED_POSITIONS: Array<{ lat: number; lon: number; heading: number }> = [
    { lat: 38.9989, lon: -84.6266, heading: 274 }, // Florence, KY (Figma #101)
    { lat: 39.9612, lon: -82.9988, heading: 88 }, // Columbus, OH
    { lat: 39.1031, lon: -84.512, heading: 180 }, // Cincinnati, OH
    { lat: 41.4993, lon: -81.6944, heading: 45 }, // Cleveland, OH
    { lat: 39.7589, lon: -84.1916, heading: 0 }, // Dayton, OH
    { lat: 41.6528, lon: -83.5379, heading: 315 }, // Toledo, OH
    { lat: 38.2527, lon: -85.7585, heading: 200 }, // Louisville, KY
    { lat: 39.7684, lon: -86.1581, heading: 270 }, // Indianapolis, IN
    { lat: 40.4406, lon: -79.9959, heading: 90 }, // Pittsburgh, PA
    { lat: 38.0406, lon: -84.5037, heading: 135 }, // Lexington, KY
  ];
  await prisma.$executeRawUnsafe(`SELECT create_monthly_partition('TelemetryPoint', $1::date)`, ANCHOR.startOf('month').toISODate());
  const equippedUnits = await prisma.device.findMany({
    where: { vehicleId: { not: null } },
    select: { vehicleId: true },
    orderBy: { serial: 'asc' },
  });
  const seededPositions: Array<{ time: Date; vehicleId: string; latitude: number; longitude: number; speedMph: number; headingDeg: number; engineOn: boolean }> = [];
  for (const [idx, { vehicleId }] of equippedUnits.entries()) {
    if (!vehicleId) continue;
    if (await prisma.telemetryPoint.findFirst({ where: { vehicleId }, select: { vehicleId: true } })) continue;
    const base = vehicleId === unit101Id ? SEED_POSITIONS[0] : SEED_POSITIONS[(idx % (SEED_POSITIONS.length - 1)) + 1];
    // Spread units sharing a city ~2-3 mi apart so markers do not stack on one pixel.
    const coarse = coarsenLocation({ lat: base.lat + (idx % 3) * 0.03, lon: base.lon + (idx % 4) * 0.03 }, 'ONE_MILE');
    seededPositions.push({
      // B-044: never after real now — Live Fleet hides future-dated fixes.
      time: seedFixTime(ANCHOR.toJSDate(), new Date(), 2 + idx),
      vehicleId,
      latitude: Number(coarse.lat.toFixed(6)),
      longitude: Number(coarse.lon.toFixed(6)),
      speedMph: 0,
      headingDeg: base.heading,
      engineOn: vehicleId === unit101Id,
    });
  }
  if (seededPositions.length) {
    await prisma.telemetryPoint.createMany({ data: seededPositions, skipDuplicates: true });
  }

  // ---- Drivers (58) --------------------------------------------------------
  const driverIds: string[] = [];
  let johnSmithId = '';
  let marcusWebbId = '';
  for (let i = 0; i < 58; i++) {
    let first: string;
    let last: string;
    let username: string;
    let cdlNumber: string;
    let assignedVehicleId: string | null = null;

    if (i === 0) {
      first = 'John';
      last = 'Smith';
      username = 'johnsmith';
      cdlNumber = 'OH-W8569238';
      assignedVehicleId = unit101Id;
    } else if (i === 1) {
      first = 'Marcus';
      last = 'Webb';
      username = 'marcuswebb';
      cdlNumber = 'OH-W4471820';
    } else if (i === 2) {
      first = 'William';
      last = 'Bond';
      username = 'williambond';
      cdlNumber = 'OH-W1129384';
      assignedVehicleId = unit104Id;
    } else {
      first = FIRST_NAMES[i % FIRST_NAMES.length];
      last = LAST_NAMES[(i * 7) % LAST_NAMES.length];
      username = `${first.toLowerCase()}${last.toLowerCase()}${i}`;
      cdlNumber = `OH-W${(1000000 + i * 37).toString().slice(0, 7)}`;
      // Keep a handful of units unassigned; give most drivers a unique unit beyond #101/#104/#110.
      const candidate = vehicleIds[(i + 10) % vehicleIds.length];
      assignedVehicleId = candidate === unit101Id || candidate === unit104Id ? null : candidate;
    }

    const driver = await prisma.driver.upsert({
      where: { username },
      create: {
        username,
        passwordHash: DEMO_PASSWORD_HASH,
        firstName: first,
        lastName: last,
        cdlNumber,
        cdlState: 'OH',
        status: DriverStatus.ACTIVE,
        homeTerminalName: 'Columbus, OH',
        homeTerminalTimezone: HOME_TZ,
        fleetManagerId: users['mike.torres@universal-logistics.example'],
        assignedVehicleId,
        appPlatform: 'ANDROID',
        sdkVersion: '6.7.1',
      },
      update: { assignedVehicleId, passwordHash: DEMO_PASSWORD_HASH },
    });
    driverIds.push(driver.id);
    if (i === 0) johnSmithId = driver.id;
    if (i === 1) marcusWebbId = driver.id;
  }

  // Driver PIN placeholder (stored alongside password hash conceptually — no dedicated
  // column exists yet in §5.3; recorded here only as a code comment for the auth module):
  void DEMO_PIN_HASH;

  // ---- Co-driver pairing: John Smith <-> Marcus Webb, unit #101 ----------
  const pairingStart = ANCHOR.minus({ days: 2 }).toJSDate();
  const existingPairing = await prisma.coDriverPairing.findFirst({
    where: { primaryDriverId: johnSmithId, coDriverId: marcusWebbId, vehicleId: unit101Id },
  });
  if (!existingPairing) {
    await prisma.coDriverPairing.create({
      data: {
        primaryDriverId: johnSmithId,
        coDriverId: marcusWebbId,
        vehicleId: unit101Id,
        startedAt: pairingStart,
        startedById: users['mike.torres@universal-logistics.example'],
      },
    });
  }

  // ---- John Smith's 8-day HOS log (tz.md §22.3.6) ------------------------
  // Today's segments (ANCHOR-relative, exact per the TZ spec):
  //   SB   ANCHOR-15:41 -> ANCHOR-13:41
  //   ON   ANCHOR-13:41 -> ANCHOR-13:11
  //   D    ANCHOR-13:11 -> ANCHOR-07:41
  //   OFF  ANCHOR-07:41 -> ANCHOR-07:11   (30 min break)
  //   D    ANCHOR-07:11 -> ANCHOR-01:15   (11:26 total -> 11h limit exceeded by 00:26)
  //   ON   ANCHOR-01:15 -> ANCHOR+01:19
  const todayLogDate = ANCHOR.startOf('day');
  const todaySegments: Array<{ status: 'OFF' | 'SB' | 'D' | 'ON'; from: DateTime; to: DateTime }> = [
    { status: 'SB', from: anchorMinus(15, 41), to: anchorMinus(13, 41) },
    { status: 'ON', from: anchorMinus(13, 41), to: anchorMinus(13, 11) },
    { status: 'D', from: anchorMinus(13, 11), to: anchorMinus(7, 41) },
    { status: 'OFF', from: anchorMinus(7, 41), to: anchorMinus(7, 11) },
    { status: 'D', from: anchorMinus(7, 11), to: anchorMinus(1, 15) },
    { status: 'ON', from: anchorMinus(1, 15), to: anchorPlus(1, 19) },
  ];

  const drivingSecToday = todaySegments
    .filter((s) => s.status === 'D')
    .reduce((sum, s) => sum + Math.round(s.to.diff(s.from, 'seconds').seconds), 0);
  const onDutySecToday = todaySegments
    .filter((s) => s.status === 'ON')
    .reduce((sum, s) => sum + Math.round(s.to.diff(s.from, 'seconds').seconds), 0);
  const offDutySecToday = todaySegments
    .filter((s) => s.status === 'OFF')
    .reduce((sum, s) => sum + Math.round(s.to.diff(s.from, 'seconds').seconds), 0);
  const sleeperSecToday = todaySegments
    .filter((s) => s.status === 'SB')
    .reduce((sum, s) => sum + Math.round(s.to.diff(s.from, 'seconds').seconds), 0);

  // 11-hour driving limit (39,600 s) exceeded by 26 minutes (1,560 s) — tz.md §22.3.6.
  const ELEVEN_HOUR_LIMIT_SEC = 11 * 3600;
  const exceededBySec = drivingSecToday - ELEVEN_HOUR_LIMIT_SEC;

  const todayDailyLog = await prisma.dailyLog.upsert({
    where: { driverId_logDate: { driverId: johnSmithId, logDate: todayLogDate.toJSDate() } },
    create: {
      driverId: johnSmithId,
      logDate: todayLogDate.toJSDate(),
      timezone: HOME_TZ,
      offDutySec: offDutySecToday,
      sleeperSec: sleeperSecToday,
      drivingSec: drivingSecToday,
      onDutySec: onDutySecToday,
      totalDistanceMi: 612,
      certified: false,
      hasViolation: true,
      violationCount: 1,
    },
    update: {
      drivingSec: drivingSecToday,
      hasViolation: true,
      violationCount: 1,
    },
  });

  await prisma.hosViolation.upsert({
    where: { driverId_logDate_type: { driverId: johnSmithId, logDate: todayLogDate.toJSDate(), type: 'DRIVING_11' } },
    create: {
      driverId: johnSmithId,
      dailyLogId: todayDailyLog.id,
      logDate: todayLogDate.toJSDate(),
      type: 'DRIVING_11',
      occurredAt: anchorMinus(1, 15).toJSDate(),
      exceededBySec,
      detail: '11-hour driving limit exceeded by 00:26',
      status: 'OPEN',
    },
    update: { exceededBySec },
  });

  // The 7 preceding days, each with a simple compliant OFF/D/ON/OFF pattern built the same
  // ANCHOR-relative way so "previous 8 days" always renders (tz.md §22.3.6).
  for (let d = 1; d <= 7; d++) {
    const dayAnchor = todayLogDate.minus({ days: d });
    await prisma.dailyLog.upsert({
      where: { driverId_logDate: { driverId: johnSmithId, logDate: dayAnchor.toJSDate() } },
      create: {
        driverId: johnSmithId,
        logDate: dayAnchor.toJSDate(),
        timezone: HOME_TZ,
        offDutySec: 10 * 3600,
        sleeperSec: 4 * 3600,
        drivingSec: 9 * 3600 + 30 * 60,
        onDutySec: 30 * 60,
        totalDistanceMi: 520,
        certified: true,
        certifiedAt: dayAnchor.plus({ hours: 20 }).toJSDate(),
        certifierType: EditorType.DRIVER,
        certificationCount: 1,
      },
      update: {},
    });
  }

  // ---- DVIRs: #88214 (pre-trip, no defects) & #88208 (post-trip, defects fixed) ----
  const dvir88214 = await prisma.dvir.findFirst({ where: { driverId: johnSmithId, odometerMi: 88214 } });
  if (!dvir88214) {
    await prisma.dvir.create({
      data: {
        driverId: johnSmithId,
        vehicleId: unit101Id,
        type: DvirType.PRE_TRIP,
        submittedAt: todayLogDate.set({ hour: 6, minute: 45 }).toJSDate(),
        odometerMi: 88214,
        vehicleCondition: DvirCondition.SATISFACTORY,
        driverSignatureUrl: 's3://onebook-dev/signatures/dvir-88214.png',
        notes: 'No defects found.',
      },
    });
  }
  const dvir88208 = await prisma.dvir.findFirst({ where: { driverId: johnSmithId, odometerMi: 88208 } });
  if (!dvir88208) {
    const created = await prisma.dvir.create({
      data: {
        driverId: johnSmithId,
        vehicleId: unit101Id,
        type: DvirType.POST_TRIP,
        submittedAt: todayLogDate.minus({ days: 2, hours: -18 }).toJSDate(),
        odometerMi: 88208,
        vehicleCondition: DvirCondition.DEFECTS_FOUND,
        driverSignatureUrl: 's3://onebook-dev/signatures/dvir-88208.png',
        notes: 'Left marker light out.',
        repairStatus: RepairStatus.REPAIRED,
        mechanicName: 'Bob Kraus',
        mechanicSignedAt: todayLogDate.minus({ days: 1 }).toJSDate(),
      },
    });
    await prisma.defect.create({
      data: {
        dvirId: created.id,
        vehicleId: unit101Id,
        category: 'Lights (Marker - Clearance)',
        part: DefectPart.TRUCK,
        severity: DefectSeverity.MINOR,
        description: 'Left marker light out.',
        status: DefectStatus.REPAIRED,
        resolvedAt: todayLogDate.minus({ days: 1 }).toJSDate(),
      },
    });
  }

  // ---- Unit #110 OUT_OF_SERVICE — critical brake defect + WO-2214 --------
  const wo2214 = await prisma.workOrder.upsert({
    where: { number: 'WO-2214' },
    create: {
      number: 'WO-2214',
      vehicleId: unit110Id,
      title: 'Critical brake system repair',
      description: 'Service brake failure found on pre-trip inspection.',
      priority: WorkOrderPriority.URGENT,
      status: WorkOrderStatus.IN_PROGRESS,
      vendor: 'Columbus Fleet Service',
      openedById: sarahChenId,
      openedAt: ANCHOR.minus({ days: 1 }).toJSDate(),
      dueAt: ANCHOR.plus({ days: 1 }).toJSDate(),
    },
    update: {},
  });
  const unit110Dvir = await prisma.dvir.findFirst({ where: { vehicleId: unit110Id, vehicleCondition: DvirCondition.DEFECTS_FOUND } });
  const unit110DvirRecord =
    unit110Dvir ??
    (await prisma.dvir.create({
      data: {
        driverId: driverIds[9] ?? johnSmithId,
        vehicleId: unit110Id,
        type: DvirType.PRE_TRIP,
        submittedAt: ANCHOR.minus({ days: 1 }).toJSDate(),
        odometerMi: 71_442,
        vehicleCondition: DvirCondition.DEFECTS_FOUND,
        driverSignatureUrl: 's3://onebook-dev/signatures/dvir-unit110.png',
        notes: 'Service brakes fail to hold — unit taken out of service.',
        repairStatus: RepairStatus.PENDING,
      },
    }));
  const existingDefect = await prisma.defect.findFirst({ where: { vehicleId: unit110Id, workOrderId: wo2214.id } });
  if (!existingDefect) {
    await prisma.defect.create({
      data: {
        dvirId: unit110DvirRecord.id,
        vehicleId: unit110Id,
        category: 'Brakes, Service',
        part: DefectPart.TRUCK,
        severity: DefectSeverity.CRITICAL,
        description: 'Service brakes fail to hold on unit #110.',
        status: DefectStatus.IN_PROGRESS,
        outOfService: true,
        workOrderId: wo2214.id,
      },
    });
  }

  // ---- Trip TR-4821 --------------------------------------------------------
  const trip = await prisma.trip.upsert({
    where: { number: 'TR-4821' },
    create: {
      number: 'TR-4821',
      driverId: johnSmithId,
      vehicleId: unit101Id,
      status: TripStatus.IN_PROGRESS,
      shippingDocument: 'BOL #4821-A',
      commodity: 'Palletized dry goods',
      weightLbs: 38_500,
      plannedStartAt: ANCHOR.minus({ hours: 7, minutes: 11 }).toJSDate(),
      startedAt: ANCHOR.minus({ hours: 7, minutes: 11 }).toJSDate(),
      etaAt: ANCHOR.plus({ hours: 3 }).toJSDate(),
      createdById: users['carlos.ramirez@universal-logistics.example'],
    },
    update: {},
  });
  const tripStopExists = await prisma.tripStop.findFirst({ where: { tripId: trip.id, sequence: 1 } });
  if (!tripStopExists) {
    await prisma.tripStop.create({
      data: {
        tripId: trip.id,
        sequence: 1,
        type: 'PICKUP',
        name: 'Columbus DC',
        address: '4821 Freight Way, Columbus, OH',
        scheduledAt: ANCHOR.minus({ hours: 7, minutes: 11 }).toJSDate(),
        arrivedAt: ANCHOR.minus({ hours: 7, minutes: 11 }).toJSDate(),
        departedAt: ANCHOR.minus({ hours: 7 }).toJSDate(),
        status: 'COMPLETED',
      },
    });
    await prisma.tripStop.create({
      data: {
        tripId: trip.id,
        sequence: 2,
        type: 'DELIVERY',
        name: 'Cincinnati DC',
        address: '900 Warehouse Row, Cincinnati, OH',
        scheduledAt: ANCHOR.plus({ hours: 3 }).toJSDate(),
        status: 'PENDING',
      },
    });
  }

  // ---- Messages + notifications -------------------------------------------
  const dispatchConvo = await prisma.conversation.findFirst({
    where: { type: ConversationType.DIRECT, participants: { some: { driverId: johnSmithId } } },
  });
  const convo =
    dispatchConvo ??
    (await prisma.conversation.create({
      data: {
        type: ConversationType.DIRECT,
        createdById: users['carlos.ramirez@universal-logistics.example'],
        lastMessageAt: ANCHOR.minus({ minutes: 20 }).toJSDate(),
        participants: {
          create: [{ userId: users['carlos.ramirez@universal-logistics.example'] }, { driverId: johnSmithId }],
        },
      },
    }));
  const hasMessage = await prisma.message.findFirst({ where: { conversationId: convo.id } });
  if (!hasMessage) {
    await prisma.message.create({
      data: {
        conversationId: convo.id,
        senderUserId: users['carlos.ramirez@universal-logistics.example'],
        body: 'Heads up — Cincinnati DC dock closes at 8pm, plan your break accordingly.',
        sentAt: ANCHOR.minus({ minutes: 20 }).toJSDate(),
      },
    });
  }

  const hasNotification = await prisma.notification.findFirst({
    where: { driverId: johnSmithId, type: 'hos_violation' },
  });
  if (!hasNotification) {
    await prisma.notification.create({
      data: {
        driverId: johnSmithId,
        type: 'hos_violation',
        title: '11-hour driving limit exceeded',
        body: 'You exceeded the 11-hour driving limit by 00:26.',
        objectType: 'HosViolation',
        objectId: todayDailyLog.id,
      },
    });
  }
  const hasAdminNotification = await prisma.notification.findFirst({
    where: { userId: sarahChenId, type: 'unit_out_of_service' },
  });
  if (!hasAdminNotification) {
    await prisma.notification.create({
      data: {
        userId: sarahChenId,
        type: 'unit_out_of_service',
        title: 'Unit #110 out of service',
        body: 'Critical brake defect — WO-2214 opened.',
        objectType: 'Vehicle',
        objectId: unit110Id,
      },
    });
  }

  // §12.7/§14 — B-39/B-74/B-83/B-15 default delivery: a background driver app only gets FCM
  // when SOME AlertRule matches the job name (`AlertProcessor.findByEvent`). No such rule
  // existed for these three driver-subject events, so a driver with the app closed got nothing
  // (D-095 follow-up). `subjectDriver: true` + IN_APP resolves to that driver and triggers
  // `AlertProcessor.send`'s existing IN_APP-notification + FCM pairing; `notifyDriver`/`notify`
  // false already short-circuits at the call site (no job is ever enqueued), so these rules
  // never need their own suppression logic.
  const defaultDriverAlertRules: Array<{
    key: string;
    name: string;
    severity: 'CRITICAL' | 'WARNING' | 'INFO';
    event: string;
  }> = [
    { key: 'default_edit_request', name: 'Log edit request', severity: 'WARNING', event: 'alert.edit_request' },
    {
      key: 'default_unidentified_confirmation_requested',
      name: 'Unidentified driving confirmation requested',
      severity: 'WARNING',
      event: 'alert.unidentified_confirmation_requested',
    },
    { key: 'default_trip_assigned', name: 'Trip assigned', severity: 'INFO', event: 'alert.trip_assigned' },
  ];
  for (const rule of defaultDriverAlertRules) {
    await prisma.alertRule.upsert({
      where: { key: rule.key },
      update: {},
      create: {
        key: rule.key,
        name: rule.name,
        severity: rule.severity,
        conditions: [{ event: rule.event }],
        channels: ['IN_APP'],
        recipients: { subjectDriver: true },
        enabled: true,
        isSystem: true,
      },
    });
  }

  console.log('Seed complete:', {
    carriers: 1,
    roles: Object.keys(roleIds).length,
    users: userSeeds.length,
    vehicles: vehicleIds.length,
    drivers: driverIds.length,
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
