/**
 * OneBook ELD — mock generator: core fleet (drivers, vehicles, trailers, PT30 devices,
 * assignments, co-driver pairings). Owns the base rows every other mock domain's FKs point at
 * — MUST exist before any other generator runs (checked against the DB by index.ts, not by
 * requiring "core" on the same command line — see decisions.md D-055).
 *
 * ID STABILITY (D-055 fix, 2026-09-14): Driver/Vehicle/Trailer/Device rows are UPSERTED by
 * their natural unique key (username / unitNumber / number / serial), never deleted and
 * recreated. A row that already exists (even with a pre-existing RANDOM id from before this
 * fix) keeps its current id forever — the `update` branch never touches `id`. Only a row that
 * does not exist yet gets a fresh id, and that id is a deterministic `mockId(domain, naturalKey)`
 * (UUID v5), so a brand-new mock row's id is also stable across every future re-run. This is
 * what lets `hos`/`ingest`/`compliance`/... write FKs against these ids without ever being
 * silently orphaned by a later `core` re-run.
 *
 * `CoDriverPairing` is the one exception: nothing else in the schema has a FK pointing AT a
 * pairing's id (it is a leaf table), so it is safe to delete-and-recreate on every run — it has
 * no natural unique column to upsert against in the first place.
 *
 * Mock identity (see prisma/mock/README.md):
 *   Driver.username   starts with "mock_"     Driver.email  ends with "@mock.onebook.example"
 *   Vehicle.unitNumber starts with "M1"       (M1001..M1170)
 *   Trailer.number     starts with "MOCKTRL-" (Trailer has no FK back to a mock driver/vehicle
 *                                              and no free-text field, so its own text-prefix
 *                                              identity is used, same pattern as unitNumber)
 *   Device.serial       starts with "MOCKPT30-" (same reasoning — spare/retired devices have
 *                                                 vehicleId = null, so the FK identity does not
 *                                                 reach them)
 */
import { DateTime } from 'luxon';
import { DeviceModel, DeviceStatus, BleState, DriverStatus, FuelType, HosRuleset, VehicleStatus } from '@prisma/client';
import { hashPassword } from '../../../src/modules/auth/lib/password.util';
import {
  MockContext,
  mockId,
  MOCK_USERNAME_PREFIX,
  MOCK_EMAIL_DOMAIN,
  MOCK_UNIT_PREFIX,
  MOCK_TRAILER_PREFIX,
  MOCK_DEVICE_PREFIX,
} from '../context';

const DRIVERS_TOTAL = 200;
const VEHICLES_TOTAL = 170;
const TRAILERS_TOTAL = 140;

/** Upsert a batch with bounded concurrency — Prisma has no bulk-upsert primitive. */
async function upsertAll<T>(items: T[], fn: (item: T) => Promise<unknown>, concurrency = 20): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn));
  }
}

const FIRST_NAMES = [
  'James', 'Robert', 'Michael', 'David', 'Richard', 'Joseph', 'Thomas', 'Charles', 'Daniel',
  'Matthew', 'Anthony', 'Mark', 'Paul', 'Steven', 'Kevin', 'Brian', 'George', 'Edward',
  'Ronald', 'Timothy', 'Jason', 'Jeffrey', 'Ryan', 'Jacob', 'Gary', 'Nicholas', 'Eric', 'Jonathan',
  'Larry', 'Justin', 'Scott', 'Brandon', 'Frank', 'Gregory', 'Raymond', 'Samuel', 'Patrick',
  'Alexander', 'Jack', 'Dennis', 'Jerry', 'Tyler', 'Aaron', 'Jose', 'Adam', 'Henry', 'Nathan',
  'Douglas', 'Zachary', 'Peter', 'Kyle', 'Walter', 'Harold', 'Carl', 'Jeremy', 'Keith', 'Roger',
  'Maria', 'Linda', 'Susan', 'Karen', 'Jessica', 'Sandra', 'Ashley', 'Kimberly', 'Donna', 'Michelle',
  'Angela', 'Melissa', 'Brenda', 'Amy', 'Rebecca', 'Laura', 'Stephanie', 'Cynthia', 'Amanda', 'Tina',
] as const;
const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez',
  'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore',
  'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark',
  'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott',
  'Torres', 'Nguyen', 'Hill', 'Flores', 'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera',
  'Campbell', 'Mitchell', 'Carter', 'Roberts', 'Webb', 'Phillips', 'Evans', 'Turner', 'Diaz',
  'Parker', 'Cruz', 'Edwards', 'Collins', 'Reyes', 'Stewart', 'Morris', 'Morales', 'Murphy',
] as const;

/** Home terminals — several US timezones, matching real cities. */
const HOME_TERMINALS: Array<{ name: string; timezone: string; cdlState: string }> = [
  { name: 'Columbus, OH', timezone: 'America/New_York', cdlState: 'OH' },
  { name: 'Atlanta, GA', timezone: 'America/New_York', cdlState: 'GA' },
  { name: 'Charlotte, NC', timezone: 'America/New_York', cdlState: 'NC' },
  { name: 'Chicago, IL', timezone: 'America/Chicago', cdlState: 'IL' },
  { name: 'Dallas, TX', timezone: 'America/Chicago', cdlState: 'TX' },
  { name: 'Kansas City, MO', timezone: 'America/Chicago', cdlState: 'MO' },
  { name: 'Denver, CO', timezone: 'America/Denver', cdlState: 'CO' },
  { name: 'Phoenix, AZ', timezone: 'America/Phoenix', cdlState: 'AZ' },
  { name: 'Los Angeles, CA', timezone: 'America/Los_Angeles', cdlState: 'CA' },
  { name: 'Seattle, WA', timezone: 'America/Los_Angeles', cdlState: 'WA' },
];

const HOS_RULESETS: HosRuleset[] = [
  HosRuleset.US_70_8_PROPERTY,
  HosRuleset.US_70_8_PROPERTY,
  HosRuleset.US_70_8_PROPERTY,
  HosRuleset.US_60_7_PROPERTY,
  HosRuleset.US_60_7_PROPERTY,
  HosRuleset.US_70_8_PASSENGER,
  HosRuleset.US_60_7_PASSENGER,
];

const MAKES: Array<[string, string]> = [
  ['Freightliner', 'Cascadia'],
  ['Freightliner', 'Columbia'],
  ['Kenworth', 'T680'],
  ['Kenworth', 'W900'],
  ['Peterbilt', '579'],
  ['Peterbilt', '389'],
  ['Volvo', 'VNL'],
  ['International', 'LT'],
  ['Mack', 'Anthem'],
];

const PLATE_STATES = ['OH', 'GA', 'NC', 'IL', 'TX', 'MO', 'CO', 'AZ', 'CA', 'WA', 'PA', 'IN', 'TN', 'NV', 'OR'];

function vinFor(idx: number): string {
  // 17-char VIN-shaped string, never colliding with the ~101-169 seed range.
  const body = (900000 + idx * 7).toString().padStart(6, '0');
  return `3AKJHHDR${idx.toString().padStart(3, '0')}MOCK${body.slice(0, 6)}`.slice(0, 17).padEnd(17, '0');
}

function randomPhone(rng: MockContext['rng']): string {
  return `+1-${rng.int(200, 989)}-555-${rng.int(1000, 9999)}`;
}

export async function run(ctx: MockContext): Promise<Record<string, number>> {
  const { prisma, rng, from, to, log } = ctx;
  const passwordHash = await hashPassword('Onebook2026');

  // Existing seeded fleet managers — mock drivers point at real ones when available, else null.
  const fleetManagers = await prisma.user.findMany({
    where: { role: { key: 'FLEET_MANAGER' } },
    select: { id: true },
  });

  // ---- Vehicles (170) — upsert by unitNumber, id stable, never wiped --------------------------
  log(`core: upserting ${VEHICLES_TOTAL} vehicles`);
  const vehicleSpecs = Array.from({ length: VEHICLES_TOTAL }, (_, i) => {
    const [make, model] = rng.pick(MAKES);
    const unitNumber = `${MOCK_UNIT_PREFIX}${(1001 + i).toString()}`;
    // ~88% ACTIVE, ~7% INACTIVE, ~5% OUT_OF_SERVICE — mirrors a real fleet's spare/downed ratio.
    const roll = rng.next();
    const status = roll < 0.88 ? VehicleStatus.ACTIVE : roll < 0.95 ? VehicleStatus.INACTIVE : VehicleStatus.OUT_OF_SERVICE;
    const activatedAt = DateTime.fromJSDate(from).minus({ months: rng.int(0, 48) }).toJSDate();
    return {
      unitNumber,
      vin: vinFor(i),
      make,
      model,
      year: 2016 + rng.int(0, 8),
      licensePlate: `${rng.pick(PLATE_STATES)}-${rng.int(10000, 99999)}`,
      plateState: rng.pick(PLATE_STATES),
      fuelType: rng.chance(0.03) ? FuelType.ELECTRIC : rng.chance(0.03) ? FuelType.CNG : FuelType.DIESEL,
      // 6 months of driving at a plausible pace, on top of prior mileage.
      odometerMi: rng.int(40_000, 480_000) + rng.int(20_000, 60_000),
      status,
      activatedAt,
    };
  });
  const vehicleIdByUnit = new Map<string, string>();
  await upsertAll(vehicleSpecs, async (v) => {
    const row = await prisma.vehicle.upsert({
      where: { unitNumber: v.unitNumber },
      create: { id: mockId('vehicle', v.unitNumber), ...v, createdAt: v.activatedAt },
      update: {
        vin: v.vin,
        make: v.make,
        model: v.model,
        year: v.year,
        licensePlate: v.licensePlate,
        plateState: v.plateState,
        fuelType: v.fuelType,
        odometerMi: v.odometerMi,
        status: v.status,
        activatedAt: v.activatedAt,
      },
    });
    vehicleIdByUnit.set(v.unitNumber, row.id);
  });
  const desiredUnitNumbers = vehicleSpecs.map((v) => v.unitNumber);
  const activeVehicleSpecs = vehicleSpecs.filter((v) => v.status === VehicleStatus.ACTIVE);

  // ---- Trailers (140) — upsert by number ------------------------------------------------------
  log(`core: upserting ${TRAILERS_TOTAL} trailers`);
  const trailerSpecs = Array.from({ length: TRAILERS_TOTAL }, (_, i) => ({
    number: `${MOCK_TRAILER_PREFIX}${(1001 + i).toString()}`,
    vin: `1TRL${(500000 + i * 3).toString().padStart(9, '0')}MK`.slice(0, 17).padEnd(17, '0'),
    status: rng.chance(0.9) ? VehicleStatus.ACTIVE : rng.chance(0.5) ? VehicleStatus.INACTIVE : VehicleStatus.OUT_OF_SERVICE,
  }));
  await upsertAll(trailerSpecs, (t) =>
    prisma.trailer.upsert({
      where: { number: t.number },
      create: { id: mockId('trailer', t.number), ...t },
      update: { vin: t.vin, status: t.status },
    }),
  );
  const desiredTrailerNumbers = trailerSpecs.map((t) => t.number);

  // ---- Drivers (200) — upsert by username, assignment resolved against the vehicle id map -----
  log(`core: upserting ${DRIVERS_TOTAL} drivers`);
  // Reserve one vehicle per assigned driver — 1:1 (Driver.assignedVehicleId is @unique). Only
  // ACTIVE vehicles get an assignment; OUT_OF_SERVICE/INACTIVE stay spare/shop trucks.
  const assignablePool = rng.shuffle(activeVehicleSpecs);
  let assignedIdx = 0;
  const driverSpecs = Array.from({ length: DRIVERS_TOTAL }, (_, i) => {
    const first = FIRST_NAMES[i % FIRST_NAMES.length];
    const last = LAST_NAMES[(i * 7 + 3) % LAST_NAMES.length];
    const username = `${MOCK_USERNAME_PREFIX}${first.toLowerCase()}${last.toLowerCase()}${i}`;
    const terminal = rng.pick(HOME_TERMINALS);
    // ~92.5% ACTIVE, ~5% INACTIVE, ~2.5% TERMINATED — "~185 active, some inactive/terminated".
    const roll = rng.next();
    const status = roll < 0.925 ? DriverStatus.ACTIVE : roll < 0.975 ? DriverStatus.INACTIVE : DriverStatus.TERMINATED;
    // registeredAt (proxy for hire date — Driver has no dedicated hireDate column): mostly
    // years before the 6-month mock window, some inside it (new hires).
    const registeredAt = rng.chance(0.7)
      ? DateTime.fromJSDate(from).minus({ months: rng.int(6, 96) }).toJSDate()
      : DateTime.fromJSDate(from).plus({ days: rng.int(0, 170) }).toJSDate();
    // ~50 unassigned by design: only ACTIVE drivers get a vehicle, and only ACTIVE vehicles are
    // assignable, so the number is bounded by min(active drivers, active vehicles) — see
    // decisions.md D-055 for why this can't hit the brief's illustrative "~15".
    let assignedUnitNumber: string | null = null;
    if (status === DriverStatus.ACTIVE && assignedIdx < assignablePool.length && rng.chance(0.92)) {
      assignedUnitNumber = assignablePool[assignedIdx++].unitNumber;
    }
    const eldExempt = rng.chance(0.02);
    return {
      username,
      firstName: first,
      lastName: last,
      email: `${username}${MOCK_EMAIL_DOMAIN}`,
      phone: randomPhone(rng),
      cdlNumber: `${terminal.cdlState}-M${(1000000 + i * 41).toString().slice(0, 7)}`,
      cdlState: terminal.cdlState,
      status,
      homeTerminalName: terminal.name,
      homeTerminalTimezone: terminal.timezone,
      hosRuleset: rng.pick(HOS_RULESETS),
      fleetManagerId: fleetManagers.length ? rng.pick(fleetManagers).id : null,
      assignedUnitNumber,
      allowPersonalConveyance: rng.chance(0.55),
      allowYardMove: rng.chance(0.5),
      adverseDrivingEnabled: rng.chance(0.1),
      shortHaulException: rng.chance(0.08),
      splitSleeperEnabled: rng.chance(0.15),
      eldExempt,
      eldExemptReason: eldExempt ? 'Short-haul / 150 air-mile radius exemption' : null,
      appVersion: rng.pick(['3.4.0', '3.5.2', '3.6.0', '3.6.1']),
      appPlatform: rng.chance(0.6) ? 'ANDROID' : 'IOS',
      sdkVersion: rng.pick(['6.5.0', '6.6.2', '6.7.1']),
      registeredAt,
    };
  });
  // Clear every existing mock driver's assignedVehicleId FIRST (Driver.assignedVehicleId is
  // @unique) — otherwise two concurrent upserts can transiently collide when this run's desired
  // assignment differs from a previous run's (driver A wants vehicle X while some other driver
  // still holds X from before). Postgres allows unlimited NULLs on a unique column, so this
  // bulk clear is itself always conflict-free.
  await prisma.driver.updateMany({
    where: { username: { startsWith: MOCK_USERNAME_PREFIX } },
    data: { assignedVehicleId: null },
  });
  const driverIdByUsername = new Map<string, string>();
  await upsertAll(driverSpecs, async (d) => {
    const assignedVehicleId = d.assignedUnitNumber ? vehicleIdByUnit.get(d.assignedUnitNumber) ?? null : null;
    const { assignedUnitNumber, ...rest } = d;
    void assignedUnitNumber;
    const row = await prisma.driver.upsert({
      where: { username: d.username },
      create: { id: mockId('driver', d.username), ...rest, passwordHash, assignedVehicleId },
      update: { ...rest, passwordHash, assignedVehicleId },
    });
    driverIdByUsername.set(d.username, row.id);
  });
  const desiredUsernames = driverSpecs.map((d) => d.username);
  const unassignedCount = driverSpecs.filter((d) => !d.assignedUnitNumber).length;

  // ---- Devices (PT30) — upsert by serial, most paired, some spare/retired ---------------------
  // Pair ~90% of ACTIVE+INACTIVE vehicles; leave the rest (incl. OUT_OF_SERVICE) without a
  // device, same as a real fleet mid-install/mid-repair. Then add spare + retired unpaired units.
  const pairableVehicles = rng.shuffle(vehicleSpecs.filter((v) => v.status !== VehicleStatus.OUT_OF_SERVICE));
  const pairCount = Math.round(pairableVehicles.length * 0.9);
  const firmwares = ['L108', 'L110', 'L113', 'L115'];
  log(`core: upserting ${pairCount} paired PT30 devices, plus spares/retired`);
  const deviceSpecs: Array<{
    serial: string;
    firmware: string;
    unitNumber: string | null;
    status: DeviceStatus;
    bleState: BleState;
    lastSeenAt: Date | null;
    pairedAt: Date | null;
    createdAt: Date;
  }> = [];
  let deviceSeq = 1;
  for (let i = 0; i < pairCount; i++) {
    const vehicle = pairableVehicles[i];
    const pairedAt = DateTime.fromJSDate(vehicle.activatedAt).plus({ days: rng.int(0, 30) }).toJSDate();
    deviceSpecs.push({
      serial: `${MOCK_DEVICE_PREFIX}${(deviceSeq++).toString().padStart(4, '0')}`,
      firmware: rng.pick(firmwares),
      unitNumber: vehicle.unitNumber,
      status: DeviceStatus.ASSIGNED,
      bleState: rng.chance(0.85) ? BleState.CONNECTED : rng.chance(0.5) ? BleState.OUT_OF_RANGE : BleState.DISCONNECTED,
      lastSeenAt: DateTime.fromJSDate(to).minus({ minutes: rng.int(1, 240) }).toJSDate(),
      pairedAt,
      createdAt: pairedAt,
    });
  }
  for (let i = 0; i < 12; i++) {
    deviceSpecs.push({
      serial: `${MOCK_DEVICE_PREFIX}${(deviceSeq++).toString().padStart(4, '0')}`,
      firmware: rng.pick(firmwares),
      unitNumber: null,
      status: DeviceStatus.UNASSIGNED,
      bleState: BleState.DISCONNECTED,
      lastSeenAt: null,
      pairedAt: null,
      createdAt: DateTime.fromJSDate(from).minus({ months: rng.int(0, 12) }).toJSDate(),
    });
  }
  for (let i = 0; i < 6; i++) {
    deviceSpecs.push({
      serial: `${MOCK_DEVICE_PREFIX}${(deviceSeq++).toString().padStart(4, '0')}`,
      firmware: rng.pick(firmwares),
      unitNumber: null,
      status: DeviceStatus.RETIRED,
      bleState: BleState.DISCONNECTED,
      lastSeenAt: DateTime.fromJSDate(from).minus({ months: rng.int(1, 6) }).toJSDate(),
      pairedAt: null,
      createdAt: DateTime.fromJSDate(from).minus({ months: rng.int(12, 36) }).toJSDate(),
    });
  }
  // Same reasoning as the driver clear above — Device.vehicleId is @@unique([vehicleId]).
  await prisma.device.updateMany({
    where: { serial: { startsWith: MOCK_DEVICE_PREFIX } },
    data: { vehicleId: null },
  });
  await upsertAll(deviceSpecs, (d) => {
    const vehicleId = d.unitNumber ? vehicleIdByUnit.get(d.unitNumber) ?? null : null;
    return prisma.device.upsert({
      where: { serial: d.serial },
      create: {
        id: mockId('device', d.serial),
        serial: d.serial,
        model: DeviceModel.PT30,
        firmware: d.firmware,
        vehicleId,
        status: d.status,
        bleState: d.bleState,
        lastSeenAt: d.lastSeenAt,
        pairedAt: d.pairedAt,
        createdAt: d.createdAt,
      },
      update: {
        firmware: d.firmware,
        vehicleId,
        status: d.status,
        bleState: d.bleState,
        lastSeenAt: d.lastSeenAt,
        pairedAt: d.pairedAt,
      },
    });
  });
  const desiredSerials = deviceSpecs.map((d) => d.serial);

  // ---- Co-driver pairings (team drivers) — leaf table, safe to delete+recreate ----------------
  // Nothing else in the schema has a FK pointing AT a pairing's id, and it has no natural unique
  // column to upsert against, so (unlike Driver/Vehicle/Trailer/Device above) it is simplest and
  // equally safe to fully replace this set every run.
  await prisma.coDriverPairing.deleteMany({ where: { primaryDriver: { username: { startsWith: MOCK_USERNAME_PREFIX } } } });
  const teamCandidates = driverSpecs.filter((d) => d.assignedUnitNumber && d.status === DriverStatus.ACTIVE);
  const coDriverCandidates = rng.shuffle(driverSpecs.filter((d) => d.status === DriverStatus.ACTIVE));
  const pairingCount = Math.min(10, teamCandidates.length, Math.floor(coDriverCandidates.length / 2));
  const usedCoDrivers = new Set<string>();
  const pairingRows: Array<{ id: string; primaryDriverId: string; coDriverId: string; vehicleId: string; startedAt: Date; endedAt: Date | null }> = [];
  for (let i = 0; i < pairingCount; i++) {
    const primary = teamCandidates[i];
    const co = coDriverCandidates.find((d) => d.username !== primary.username && !usedCoDrivers.has(d.username));
    if (!co) continue;
    usedCoDrivers.add(co.username);
    usedCoDrivers.add(primary.username);
    const startedAt = DateTime.fromJSDate(from).plus({ days: rng.int(0, 120) }).toJSDate();
    const ended = rng.chance(0.3);
    const vehicleId = vehicleIdByUnit.get(primary.assignedUnitNumber as string);
    const primaryDriverId = driverIdByUsername.get(primary.username);
    const coDriverId = driverIdByUsername.get(co.username);
    if (!vehicleId || !primaryDriverId || !coDriverId) continue;
    pairingRows.push({
      id: mockId('pairing', `${primary.username}:${co.username}`),
      primaryDriverId,
      coDriverId,
      vehicleId,
      startedAt,
      endedAt: ended ? DateTime.fromJSDate(startedAt).plus({ days: rng.int(5, 60) }).toJSDate() : null,
    });
  }
  if (pairingRows.length) {
    await prisma.coDriverPairing.createMany({ data: pairingRows });
  }

  // ---- Cleanup: remove only mock core rows that no longer belong to the generated set ---------
  // (Children before parents. Given fixed constants + fixed seed this set never shrinks between
  // runs today, but the guard is real: it protects the day someone lowers a *_TOTAL constant.)
  // B-047: a downstream generator (compliance/fleet/hos/...) may since have written Dvir/DailyLog/
  // EldEvent/etc. rows against one of these ids. Deleting such a row is a real FK violation the
  // DB is right to refuse — core must report it and move on, never crash the whole pipeline run
  // over an id it would otherwise have left untouched (extras are empty in every normal run).
  async function safeDeleteExtra(label: string, fn: () => Promise<{ count: number }>): Promise<void> {
    try {
      const { count } = await fn();
      if (count) log(`core: removed ${count} stale mock ${label} row(s) no longer in the generated set`);
    } catch (err) {
      log(
        `core: WARNING — could not remove stale mock ${label} row(s), left in place ` +
          `(likely referenced by downstream mock data): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await safeDeleteExtra('device', () =>
    prisma.device.deleteMany({
      where: { AND: [{ serial: { startsWith: MOCK_DEVICE_PREFIX } }, { serial: { notIn: desiredSerials } }] },
    }),
  );
  await safeDeleteExtra('driver', () =>
    prisma.driver.deleteMany({
      where: { AND: [{ username: { startsWith: MOCK_USERNAME_PREFIX } }, { username: { notIn: desiredUsernames } }] },
    }),
  );
  await safeDeleteExtra('vehicle', () =>
    prisma.vehicle.deleteMany({
      where: { AND: [{ unitNumber: { startsWith: MOCK_UNIT_PREFIX } }, { unitNumber: { notIn: desiredUnitNumbers } }] },
    }),
  );
  await safeDeleteExtra('trailer', () =>
    prisma.trailer.deleteMany({
      where: { AND: [{ number: { startsWith: MOCK_TRAILER_PREFIX } }, { number: { notIn: desiredTrailerNumbers } }] },
    }),
  );

  log(
    `core: done — ${vehicleSpecs.length} vehicles, ${trailerSpecs.length} trailers, ${deviceSpecs.length} devices, ` +
      `${driverSpecs.length} drivers (${unassignedCount} unassigned), ${pairingRows.length} co-driver pairings`,
  );

  return {
    vehicles: vehicleSpecs.length,
    trailers: trailerSpecs.length,
    devices: deviceSpecs.length,
    drivers: driverSpecs.length,
    unassignedDrivers: unassignedCount,
    coDriverPairings: pairingRows.length,
  };
}
