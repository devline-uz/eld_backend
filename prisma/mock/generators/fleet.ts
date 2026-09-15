/**
 * OneBook ELD — mock generator: fleet (DVIR, defects, work orders, maintenance schedules,
 * trips/dispatch, geofences). Runs after `core -> users -> hos -> ingest -> compliance`.
 *
 * Mock identity (see prisma/mock/README.md):
 *   Dvir/Defect/WorkOrder/MaintenanceSchedule/Trip — reached transitively via mock
 *   Driver.username ("mock_...") / Vehicle.unitNumber ("M1...") FKs.
 *   Geofence has no FK back to a mock driver/vehicle/user, so it is tagged with the literal
 *   "[mock]" marker (MOCK_TAG) at the start of its `name`.
 *   CoDriverPairing: owned by `core.ts` — this generator only reads it (never creates/deletes).
 */
import { randomUUID } from 'crypto';
import { DateTime } from 'luxon';
import {
  DvirType,
  DvirCondition,
  RepairStatus,
  DefectPart,
  DefectSeverity,
  DefectStatus,
  WorkOrderStatus,
  WorkOrderPriority,
  TripStatus,
  StopType,
  StopStatus,
  GeofenceType,
  VehicleStatus,
  EditorType,
  Prisma,
} from '@prisma/client';
import { MockContext, MOCK_TAG, clampToNow } from '../context';
import { dateKey, groupDrivingDays } from './fleet.helpers';

const MOCK_USERNAME_PREFIX = 'mock_';
const MOCK_UNIT_PREFIX = 'M1';
const MOCK_TRAILER_PREFIX = 'MOCKTRL-';

/** eld-ingest's DUTY_STATUS eventType/eventCode constants (src/modules/ingest/event-codes.ts). */
const EVENT_TYPE_DUTY_STATUS = 1;
const DUTY_CODE_DRIVING = 3;

const CHUNK = 5000;

async function createManyChunked<T>(fn: (rows: T[]) => Promise<unknown>, rows: T[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await fn(rows.slice(i, i + CHUNK));
  }
}

// ---------------------------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------------------------

const US_CITIES: Array<{ name: string; state: string; lat: number; lon: number }> = [
  { name: 'Columbus', state: 'OH', lat: 39.9612, lon: -82.9988 },
  { name: 'Atlanta', state: 'GA', lat: 33.749, lon: -84.388 },
  { name: 'Charlotte', state: 'NC', lat: 35.2271, lon: -80.8431 },
  { name: 'Chicago', state: 'IL', lat: 41.8781, lon: -87.6298 },
  { name: 'Dallas', state: 'TX', lat: 32.7767, lon: -96.797 },
  { name: 'Kansas City', state: 'MO', lat: 39.0997, lon: -94.5786 },
  { name: 'Denver', state: 'CO', lat: 39.7392, lon: -104.9903 },
  { name: 'Phoenix', state: 'AZ', lat: 33.4484, lon: -112.074 },
  { name: 'Los Angeles', state: 'CA', lat: 34.0522, lon: -118.2437 },
  { name: 'Seattle', state: 'WA', lat: 47.6062, lon: -122.3321 },
  { name: 'Memphis', state: 'TN', lat: 35.1495, lon: -90.049 },
  { name: 'Indianapolis', state: 'IN', lat: 39.7684, lon: -86.1581 },
  { name: 'Nashville', state: 'TN', lat: 36.1627, lon: -86.7816 },
  { name: 'Louisville', state: 'KY', lat: 38.2527, lon: -85.7585 },
  { name: 'Jacksonville', state: 'FL', lat: 30.3322, lon: -81.6557 },
  { name: 'Salt Lake City', state: 'UT', lat: 40.7608, lon: -111.891 },
  { name: 'Portland', state: 'OR', lat: 45.5152, lon: -122.6784 },
  { name: 'Oklahoma City', state: 'OK', lat: 35.4676, lon: -97.5164 },
];

const DEFECT_CATALOG: Array<{ category: string; part: DefectPart; severities: DefectSeverity[] }> = [
  { category: 'Lights (Marker - Clearance)', part: DefectPart.TRUCK, severities: [DefectSeverity.MINOR] },
  { category: 'Wipers', part: DefectPart.TRUCK, severities: [DefectSeverity.MINOR] },
  { category: 'Mirrors', part: DefectPart.TRUCK, severities: [DefectSeverity.MINOR] },
  { category: 'Horn', part: DefectPart.TRUCK, severities: [DefectSeverity.MINOR] },
  { category: 'Tires', part: DefectPart.TRUCK, severities: [DefectSeverity.MINOR, DefectSeverity.MAJOR, DefectSeverity.CRITICAL] },
  { category: 'Tires', part: DefectPart.TRAILER, severities: [DefectSeverity.MINOR, DefectSeverity.MAJOR, DefectSeverity.CRITICAL] },
  { category: 'Brakes, Service', part: DefectPart.TRUCK, severities: [DefectSeverity.MAJOR, DefectSeverity.CRITICAL] },
  { category: 'Brakes, Parking', part: DefectPart.TRUCK, severities: [DefectSeverity.MAJOR, DefectSeverity.CRITICAL] },
  { category: 'Brakes', part: DefectPart.TRAILER, severities: [DefectSeverity.MAJOR, DefectSeverity.CRITICAL] },
  { category: 'Steering', part: DefectPart.TRUCK, severities: [DefectSeverity.MAJOR, DefectSeverity.CRITICAL] },
  { category: 'Coupling Devices', part: DefectPart.TRAILER, severities: [DefectSeverity.MAJOR, DefectSeverity.CRITICAL] },
  { category: 'Suspension', part: DefectPart.TRUCK, severities: [DefectSeverity.MAJOR] },
  { category: 'Exhaust System', part: DefectPart.TRUCK, severities: [DefectSeverity.MINOR, DefectSeverity.MAJOR] },
  { category: 'Fuel System', part: DefectPart.TRUCK, severities: [DefectSeverity.MAJOR, DefectSeverity.CRITICAL] },
  { category: 'Windshield / Glass', part: DefectPart.TRUCK, severities: [DefectSeverity.MINOR] },
  { category: 'Battery / Electrical', part: DefectPart.TRUCK, severities: [DefectSeverity.MINOR, DefectSeverity.MAJOR] },
  { category: 'Body / Doors', part: DefectPart.TRAILER, severities: [DefectSeverity.MINOR] },
  { category: 'Reflectors', part: DefectPart.TRAILER, severities: [DefectSeverity.MINOR] },
];

const MECHANIC_NAMES = ['Bob Kraus', 'Linda Ortiz', 'Miguel Vega', 'Carl Dunn', 'Denise Park', 'Tyrell Boone'];
const VENDORS = [
  'Columbus Fleet Service',
  'TA Truck Service',
  'Love\'s Truck Care',
  "Rush Truck Centers",
  'Freightliner of Atlanta',
  'Kenworth NW',
  'Independent Diesel Repair',
  'In-house shop',
];

const MAINT_TEMPLATES: Array<{ name: string; intervalMi: number | null; intervalDays: number | null }> = [
  { name: 'Oil & Filter Change', intervalMi: 25000, intervalDays: null },
  { name: 'PM-A Service', intervalMi: 25000, intervalDays: null },
  { name: 'PM-B Service', intervalMi: 50000, intervalDays: null },
  { name: 'Annual DOT Inspection', intervalMi: null, intervalDays: 365 },
  { name: 'Tire Rotation & Inspection', intervalMi: 20000, intervalDays: null },
  { name: 'Brake Inspection & Service', intervalMi: null, intervalDays: 180 },
];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

export async function run(ctx: MockContext): Promise<Record<string, number>> {
  const { prisma, rng, from, to, log } = ctx;

  const drivers = await prisma.driver.findMany({
    where: { username: { startsWith: MOCK_USERNAME_PREFIX } },
    select: { id: true, homeTerminalTimezone: true, assignedVehicleId: true, status: true },
  });
  const vehicles = await prisma.vehicle.findMany({
    where: { unitNumber: { startsWith: MOCK_UNIT_PREFIX } },
    select: { id: true, unitNumber: true, odometerMi: true, status: true },
  });
  const trailers = await prisma.trailer.findMany({
    where: { number: { startsWith: MOCK_TRAILER_PREFIX } },
    select: { id: true },
  });

  if (drivers.length === 0 || vehicles.length === 0) {
    throw new Error(
      'fleet: no mock drivers/vehicles found — run `npm run db:mock -- core` (and ideally `hos`) first.',
    );
  }

  const vehicleIds = vehicles.map((v) => v.id);
  const driverIds = drivers.map((d) => d.id);

  // Reference "opener/creator" for FK-required fields — reuse the real seeded fleet manager the
  // same way prisma/seed.ts and core.ts do; these rows are not mock rows themselves so they are
  // never touched/deleted by this generator.
  const opener =
    (await prisma.user.findFirst({ where: { role: { key: 'FLEET_MANAGER' } }, orderBy: { createdAt: 'asc' } })) ??
    (await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } }));
  if (!opener) {
    throw new Error('fleet: no User row exists at all to use as work-order/trip opener — seed the DB first.');
  }

  // ---- idempotent cleanup (children before parents; own rows only) --------------------------
  log('fleet: cleaning previous mock rows');
  await prisma.defect.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.workOrder.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.dvir.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  // Unassigned mock loads have driverId=null AND vehicleId=null (no FK reaches them), so they are
  // additionally tagged via the "[mock]" marker in `notes` for cleanup identity.
  const tripOwnFilter = { OR: [{ vehicleId: { in: vehicleIds } }, { driverId: { in: driverIds } }, { notes: { startsWith: `[${MOCK_TAG}]` } }] };
  await prisma.tripStop.deleteMany({ where: { trip: tripOwnFilter } });
  await prisma.trip.deleteMany({ where: tripOwnFilter });
  await prisma.maintenanceSchedule.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
  await prisma.geofence.deleteMany({ where: { name: { startsWith: `[${MOCK_TAG}]` } } });

  // ---- driving days per driver, from hos EldEvents (falls back to a synthetic pattern if the
  // hos generator has not produced events yet, so this generator never hard-fails on ordering) --
  const drivingEvents = await prisma.eldEvent.findMany({
    where: {
      driverId: { in: driverIds },
      eventType: EVENT_TYPE_DUTY_STATUS,
      eventCode: DUTY_CODE_DRIVING,
      eventDateTime: { gte: from, lte: to },
    },
    select: { driverId: true, vehicleId: true, eventDateTime: true },
  });
  const eventsByDriver = new Map<string, Array<{ vehicleId: string | null; eventDateTime: Date }>>();
  for (const e of drivingEvents) {
    if (!e.driverId) continue;
    const arr = eventsByDriver.get(e.driverId) ?? [];
    arr.push({ vehicleId: e.vehicleId, eventDateTime: e.eventDateTime });
    eventsByDriver.set(e.driverId, arr);
  }
  const usedHosAlignment = drivingEvents.length > 0;
  if (!usedHosAlignment) {
    log('fleet: WARNING — no hos EldEvent driving records found for mock drivers; using a synthetic driving-day pattern instead');
  }

  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));

  // Running odometer per vehicle so DVIR/trip odometer readings are monotonic and plausible.
  const odometerCursor = new Map<string, number>();
  for (const v of vehicles) odometerCursor.set(v.id, Math.max(1000, v.odometerMi - rng.int(15000, 60000)));

  const dvirRows: Array<{
    id: string;
    driverId: string;
    vehicleId: string;
    trailerId: string | null;
    type: DvirType;
    submittedAt: Date;
    odometerMi: number;
    vehicleCondition: DvirCondition;
    driverSignatureUrl: string;
    driverSignatureHash: string;
    notes: string | null;
    mechanicName: string | null;
    mechanicSignedAt: Date | null;
    mechanicNote: string | null;
    repairStatus: RepairStatus;
    nextDriverReviewedAt: Date | null;
  }> = [];

  const defectRows: Array<{
    id: string;
    dvirId: string;
    vehicleId: string;
    category: string;
    part: DefectPart;
    severity: DefectSeverity;
    description: string;
    status: DefectStatus;
    outOfService: boolean;
    workOrderId: string | null;
    resolvedAt: Date | null;
    resolvedById: string | null;
    resolutionNote: string | null;
    createdAt: Date;
  }> = [];

  const attachmentRows: Array<{
    id: string;
    key: string;
    mimeType: string;
    sizeBytes: number;
    dvirId: string | null;
    defectId: string | null;
    uploadedById: string | null;
    uploadedByType: EditorType;
    createdAt: Date;
  }> = [];

  const workOrderRows: Array<{
    id: string;
    number: string;
    vehicleId: string;
    title: string;
    description: string;
    priority: WorkOrderPriority;
    status: WorkOrderStatus;
    vendor: string;
    costUsd: number;
    odometerMi: number;
    openedById: string;
    openedAt: Date;
    dueAt: Date | null;
    closedAt: Date | null;
  }> = [];

  const tripRows: Array<{
    id: string;
    number: string;
    driverId: string | null;
    vehicleId: string | null;
    trailerId: string | null;
    status: TripStatus;
    shippingDocument: string;
    commodity: string;
    weightLbs: number;
    pieces: number;
    plannedStartAt: Date;
    plannedEndAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    etaAt: Date | null;
    onTime: boolean | null;
    notes: string | null;
    createdById: string;
    createdAt: Date;
  }> = [];

  const tripStopRows: Array<{
    id: string;
    tripId: string;
    sequence: number;
    type: StopType;
    name: string;
    address: string;
    latitude: number;
    longitude: number;
    scheduledAt: Date | null;
    arrivedAt: Date | null;
    departedAt: Date | null;
    status: StopStatus;
  }> = [];

  let woSeq = 1;
  let tripSeq = 1;
  let outOfServiceCount = 0;
  const nowDt = DateTime.fromJSDate(to);

  // Vehicles that will actually end up OUT_OF_SERVICE right now because of an open critical
  // defect (§out-of-service rule). Cap at a small share so most of the fleet stays usable.
  const oosTargetVehicleIds = new Set(rng.shuffle(vehicleIds).slice(0, Math.max(1, Math.round(vehicleIds.length * 0.04))));

  // Driving-day spans per driver, computed once and reused by both the DVIR loop below and the
  // trip-grouping loop further down (falls back to a synthetic ~4-days/week pattern when the
  // `hos` generator has not produced EldEvent driving records yet for that driver).
  type DaySpan = { day: string; first: Date; last: Date; vehicleId: string | null };
  const driverDaysMap = new Map<string, DaySpan[]>();
  for (const driver of drivers) {
    const tz = driver.homeTerminalTimezone;
    let days = groupDrivingDays(eventsByDriver.get(driver.id) ?? [], tz);
    if (days.length === 0 && driver.assignedVehicleId) {
      const synthetic: DaySpan[] = [];
      let cursor = DateTime.fromJSDate(from);
      const end = DateTime.fromJSDate(to);
      while (cursor < end) {
        if (rng.chance(0.55)) {
          const startHour = rng.int(5, 9);
          const first = cursor.set({ hour: startHour, minute: rng.int(0, 59) });
          const last = clampToNow(first.plus({ hours: rng.int(6, 10) }).toJSDate(), ctx);
          synthetic.push({ day: dateKey(cursor), first: first.toJSDate(), last, vehicleId: driver.assignedVehicleId });
        }
        cursor = cursor.plus({ days: 1 });
      }
      days = synthetic;
    }
    driverDaysMap.set(driver.id, days);
  }

  for (const driver of drivers) {
    const days = driverDaysMap.get(driver.id) ?? [];
    for (const d of days) {
      const vehicleId = d.vehicleId ?? driver.assignedVehicleId;
      if (!vehicleId || !vehicleById.has(vehicleId)) continue;
      // Leave ~15% of driving days with no DVIR at all — missing-inspection compliance gap.
      if (rng.chance(0.15)) continue;

      const trailerId = trailers.length && rng.chance(0.6) ? rng.pick(trailers).id : null;
      const cursor = odometerCursor.get(vehicleId) ?? 50000;
      const dayMiles = rng.int(180, 520);

      // Pre-trip
      const preOdometer = cursor;
      const preHasDefect = rng.chance(0.12);
      const preSubmittedAt = clampToNow(DateTime.fromJSDate(d.first).minus({ minutes: rng.int(10, 45) }).toJSDate(), ctx);
      const preDvirId = randomUUID();
      let preRepairStatus: RepairStatus = RepairStatus.NOT_REQUIRED;
      let preResolvedAt: Date | null = null;
      if (preHasDefect) {
        const entry = rng.pick(DEFECT_CATALOG);
        const severity = rng.pick(entry.severities);
        // §out-of-service rule: an OPEN CRITICAL defect ALWAYS forces the vehicle OUT_OF_SERVICE
        // — so CRITICAL severity may only land on OPEN for the small pre-selected OOS-target set;
        // every other vehicle gets a CRITICAL defect that is already being worked (never bare OPEN).
        const canBeOpenCritical = severity === DefectSeverity.CRITICAL && oosTargetVehicleIds.has(vehicleId);
        let status = canBeOpenCritical
          ? DefectStatus.OPEN
          : severity === DefectSeverity.CRITICAL
            ? rng.pick([DefectStatus.REPAIRED, DefectStatus.REPAIRED, DefectStatus.IN_PROGRESS, DefectStatus.DEFERRED])
            : rng.pick([DefectStatus.REPAIRED, DefectStatus.REPAIRED, DefectStatus.IN_PROGRESS, DefectStatus.DEFERRED, DefectStatus.OPEN]);
        const isOos = severity === DefectSeverity.CRITICAL && status === DefectStatus.OPEN;
        // The repair/close/sign/review chain below only ever moves FORWARD in time from
        // `preSubmittedAt` — if the randomly drawn offset would land after `ctx.to`, that step
        // has not actually happened yet in-universe: downgrade the status instead of clamping the
        // timestamp (a clamp would falsely claim the repair finished exactly "now").
        if (status === DefectStatus.REPAIRED) {
          const candidate = DateTime.fromJSDate(preSubmittedAt).plus({ hours: rng.int(2, 72) }).toJSDate();
          if (candidate.getTime() <= to.getTime()) {
            preResolvedAt = candidate;
          } else {
            status = DefectStatus.IN_PROGRESS;
          }
        }
        preRepairStatus =
          status === DefectStatus.REPAIRED ? RepairStatus.REPAIRED : status === DefectStatus.DEFERRED ? RepairStatus.DEFERRED : RepairStatus.PENDING;
        const defectId = randomUUID();
        let workOrderId: string | null = null;
        if (rng.chance(0.7) || isOos) {
          workOrderId = randomUUID();
          const opened = preSubmittedAt;
          const isClosed = status === DefectStatus.REPAIRED;
          // Closes at the same moment the defect was actually resolved — never a second,
          // independently-drawn (and potentially future) offset.
          const closedAt = isClosed ? preResolvedAt : null;
          workOrderRows.push({
            id: workOrderId,
            number: `WO-M${woSeq++}`,
            vehicleId,
            title: `${entry.category} repair`,
            description: `${entry.category} defect found on pre-trip DVIR. Parts: as needed. Labor: ${rng.int(1, 8)}h.`,
            priority: isOos
              ? WorkOrderPriority.URGENT
              : severity === DefectSeverity.MAJOR
                ? WorkOrderPriority.HIGH
                : rng.pick([WorkOrderPriority.LOW, WorkOrderPriority.NORMAL]),
            status: isClosed
              ? WorkOrderStatus.DONE
              : status === DefectStatus.DEFERRED
                ? WorkOrderStatus.CANCELLED
                : status === DefectStatus.IN_PROGRESS
                  ? WorkOrderStatus.IN_PROGRESS
                  : WorkOrderStatus.OPEN,
            vendor: rng.pick(VENDORS),
            costUsd: Math.round(rng.float(80, 3200) * 100) / 100,
            odometerMi: preOdometer,
            openedById: opener.id,
            openedAt: opened,
            dueAt: isClosed ? null : clampToNow(DateTime.fromJSDate(opened).plus({ days: rng.int(1, 10) }).toJSDate(), ctx),
            closedAt,
          });
        }
        defectRows.push({
          id: defectId,
          dvirId: preDvirId,
          vehicleId,
          category: entry.category,
          part: entry.part,
          severity,
          description: `${entry.category} — ${severity === DefectSeverity.CRITICAL ? 'fails to hold/operate safely' : severity === DefectSeverity.MAJOR ? 'operating outside spec' : 'minor wear noted'}.`,
          status,
          outOfService: isOos,
          workOrderId,
          resolvedAt: preResolvedAt,
          resolvedById: status === DefectStatus.REPAIRED ? opener.id : null,
          resolutionNote: status === DefectStatus.REPAIRED ? 'Repaired and returned to service.' : null,
          createdAt: preSubmittedAt,
        });
        if (isOos) outOfServiceCount++;
        if (rng.chance(0.4)) {
          attachmentRows.push({
            id: randomUUID(),
            key: `mock/dvir/${preDvirId}/defect-${defectId}.jpg`,
            mimeType: 'image/jpeg',
            sizeBytes: rng.int(80_000, 900_000),
            dvirId: null,
            defectId,
            uploadedById: null,
            uploadedByType: EditorType.DRIVER,
            createdAt: preSubmittedAt,
          });
        }
      }
      if (!preHasDefect && rng.chance(0.1)) {
        attachmentRows.push({
          id: randomUUID(),
          key: `mock/dvir/${preDvirId}/photo.jpg`,
          mimeType: 'image/jpeg',
          sizeBytes: rng.int(80_000, 900_000),
          dvirId: preDvirId,
          defectId: null,
          uploadedById: null,
          uploadedByType: EditorType.DRIVER,
          createdAt: preSubmittedAt,
        });
      }
      dvirRows.push({
        id: preDvirId,
        driverId: driver.id,
        vehicleId,
        trailerId,
        type: DvirType.PRE_TRIP,
        submittedAt: preSubmittedAt,
        odometerMi: preOdometer,
        vehicleCondition: preHasDefect ? DvirCondition.DEFECTS_FOUND : DvirCondition.SATISFACTORY,
        driverSignatureUrl: `mock/signatures/${preDvirId}.png`,
        driverSignatureHash: randomUUID().replace(/-/g, ''),
        notes: preHasDefect ? null : 'No defects found.',
        mechanicName: preHasDefect && rng.chance(0.6) ? rng.pick(MECHANIC_NAMES) : null,
        // Signs off at the same moment the defect was actually resolved (never a second,
        // independently-drawn offset that could land after `preResolvedAt` is even set).
        mechanicSignedAt: preRepairStatus === RepairStatus.REPAIRED ? preResolvedAt : null,
        mechanicNote: preRepairStatus === RepairStatus.REPAIRED ? 'Repaired per work order.' : null,
        repairStatus: preRepairStatus,
        nextDriverReviewedAt: (() => {
          if (preRepairStatus !== RepairStatus.REPAIRED || !preResolvedAt || !rng.chance(0.8)) return null;
          const candidate = DateTime.fromJSDate(preResolvedAt).plus({ hours: rng.int(24, 96) }).toJSDate();
          return candidate.getTime() <= to.getTime() ? candidate : null;
        })(),
      });

      const postOdometer = preOdometer + dayMiles;
      odometerCursor.set(vehicleId, postOdometer);

      // Post-trip — occasionally missing even when pre-trip exists.
      if (rng.chance(0.9)) {
        const postHasDefect = rng.chance(0.08);
        const postSubmittedAt = clampToNow(DateTime.fromJSDate(d.last).plus({ minutes: rng.int(5, 40) }).toJSDate(), ctx);
        const postDvirId = randomUUID();
        let postRepairStatus: RepairStatus = RepairStatus.NOT_REQUIRED;
        if (postHasDefect) {
          const entry = rng.pick(DEFECT_CATALOG);
          const severity = rng.pick(entry.severities.filter((s) => s !== DefectSeverity.CRITICAL) as DefectSeverity[]) ?? DefectSeverity.MINOR;
          let status = rng.pick([DefectStatus.REPAIRED, DefectStatus.OPEN, DefectStatus.IN_PROGRESS]);
          // Same forward-only rule as the pre-trip block: a resolution offset landing after
          // `ctx.to` means the repair has not actually happened yet — downgrade, don't clamp.
          let postResolvedAt: Date | null = null;
          if (status === DefectStatus.REPAIRED) {
            const candidate = DateTime.fromJSDate(postSubmittedAt).plus({ hours: rng.int(2, 48) }).toJSDate();
            if (candidate.getTime() <= to.getTime()) {
              postResolvedAt = candidate;
            } else {
              status = DefectStatus.IN_PROGRESS;
            }
          }
          postRepairStatus = status === DefectStatus.REPAIRED ? RepairStatus.REPAIRED : RepairStatus.PENDING;
          defectRows.push({
            id: randomUUID(),
            dvirId: postDvirId,
            vehicleId,
            category: entry.category,
            part: entry.part,
            severity,
            description: `${entry.category} — noted on post-trip inspection.`,
            status,
            outOfService: false,
            workOrderId: null,
            resolvedAt: postResolvedAt,
            resolvedById: status === DefectStatus.REPAIRED ? opener.id : null,
            resolutionNote: status === DefectStatus.REPAIRED ? 'Repaired and returned to service.' : null,
            createdAt: postSubmittedAt,
          });
        }
        dvirRows.push({
          id: postDvirId,
          driverId: driver.id,
          vehicleId,
          trailerId,
          type: DvirType.POST_TRIP,
          submittedAt: postSubmittedAt,
          odometerMi: postOdometer,
          vehicleCondition: postHasDefect ? DvirCondition.DEFECTS_FOUND : DvirCondition.SATISFACTORY,
          driverSignatureUrl: `mock/signatures/${postDvirId}.png`,
          driverSignatureHash: randomUUID().replace(/-/g, ''),
          notes: postHasDefect ? null : 'No defects found.',
          mechanicName: null,
          mechanicSignedAt: null,
          mechanicNote: null,
          repairStatus: postRepairStatus,
          nextDriverReviewedAt: null,
        });
      }
    }
  }

  log(`fleet: generated ${dvirRows.length} DVIRs, ${defectRows.length} defects (${outOfServiceCount} open critical/OOS), ${workOrderRows.length} work orders from driving days`);

  // ---- extra standalone work orders (not tied to a DVIR defect) — overdue / recent / closed ---
  const extraWoCount = Math.round(vehicles.length * 0.3);
  for (let i = 0; i < extraWoCount; i++) {
    const vehicle = rng.pick(vehicles);
    const openedAt = DateTime.fromJSDate(from).plus({ days: rng.int(0, 175) });
    const bucket = rng.pick(['overdue', 'recent', 'closed'] as const);
    let status: WorkOrderStatus =
      bucket === 'closed' ? WorkOrderStatus.DONE : rng.pick([WorkOrderStatus.OPEN, WorkOrderStatus.IN_PROGRESS]);
    const dueAt =
      bucket === 'overdue'
        ? DateTime.fromJSDate(to).minus({ days: rng.int(1, 20) })
        : bucket === 'recent'
          ? DateTime.fromJSDate(to).plus({ days: rng.int(1, 21) })
          : null;
    // A "closed" work order's `closedAt` must actually be in the past — if the drawn offset would
    // land after `ctx.to`, it has not really closed yet: downgrade to IN_PROGRESS instead of
    // clamping the timestamp.
    let closedAt: Date | null = null;
    if (status === WorkOrderStatus.DONE) {
      const candidate = openedAt.plus({ days: rng.int(1, 14) }).toJSDate();
      if (candidate.getTime() <= to.getTime()) {
        closedAt = candidate;
      } else {
        status = WorkOrderStatus.IN_PROGRESS;
      }
    }
    workOrderRows.push({
      id: randomUUID(),
      number: `WO-M${woSeq++}`,
      vehicleId: vehicle.id,
      title: rng.pick(['Scheduled PM service', 'Tire replacement', 'AC repair', 'Electrical diagnostics', 'Body/collision repair']),
      description: `Routine shop work. Parts: various. Labor: ${rng.int(1, 12)}h.`,
      priority: rng.pick([WorkOrderPriority.LOW, WorkOrderPriority.NORMAL, WorkOrderPriority.HIGH]),
      status,
      vendor: rng.pick(VENDORS),
      costUsd: Math.round(rng.float(60, 2400) * 100) / 100,
      odometerMi: Math.max(0, vehicle.odometerMi - rng.int(0, 30000)),
      openedById: opener.id,
      openedAt: openedAt.toJSDate(),
      dueAt: dueAt ? clampToNow(dueAt.toJSDate(), ctx) : null,
      closedAt,
    });
  }

  // ---- maintenance schedules (every vehicle gets 3-5 of the templates) ------------------------
  const maintRows: Array<{
    id: string;
    vehicleId: string;
    name: string;
    intervalMi: number | null;
    intervalDays: number | null;
    lastServiceMi: number | null;
    lastServiceAt: Date | null;
    nextDueMi: number | null;
    nextDueAt: Date | null;
    enabled: boolean;
  }> = [];
  for (const vehicle of vehicles) {
    const templates = rng.shuffle(MAINT_TEMPLATES).slice(0, rng.int(3, MAINT_TEMPLATES.length));
    for (const t of templates) {
      const lastServiceAt = DateTime.fromJSDate(from).minus({ days: rng.int(0, 200) });
      const lastServiceMi = Math.max(0, vehicle.odometerMi - rng.int(1000, 60000));
      const bucket = rng.pick(['overdue', 'due_soon', 'fine'] as const);
      let nextDueAt: DateTime | null = null;
      let nextDueMi: number | null = null;
      if (t.intervalDays) {
        nextDueAt =
          bucket === 'overdue'
            ? nowDt.minus({ days: rng.int(1, 30) })
            : bucket === 'due_soon'
              ? nowDt.plus({ days: rng.int(1, 14) })
              : nowDt.plus({ days: rng.int(30, 300) });
      }
      if (t.intervalMi) {
        const delta = bucket === 'overdue' ? -rng.int(500, 4000) : bucket === 'due_soon' ? rng.int(100, 1500) : rng.int(4000, 20000);
        nextDueMi = vehicle.odometerMi + delta;
      }
      maintRows.push({
        id: randomUUID(),
        vehicleId: vehicle.id,
        name: t.name,
        intervalMi: t.intervalMi,
        intervalDays: t.intervalDays,
        lastServiceMi,
        lastServiceAt: lastServiceAt.toJSDate(),
        nextDueMi,
        nextDueAt: nextDueAt ? nextDueAt.toJSDate() : null,
        enabled: rng.chance(0.95),
      });
    }
  }

  // ---- geofences (terminals, customer sites, yards, restricted zones) -------------------------
  const geofenceRows: Array<{
    id: string;
    name: string;
    type: GeofenceType;
    centerLat: number | null;
    centerLon: number | null;
    radiusMi: number | null;
    polygon: Prisma.InputJsonValue | typeof Prisma.JsonNull;
    category: string;
    alertOnEnter: boolean;
    alertOnExit: boolean;
    enabled: boolean;
    createdAt: Date;
  }> = [];
  const terminalCities = US_CITIES.slice(0, 6);
  for (const c of terminalCities) {
    geofenceRows.push({
      id: randomUUID(),
      name: `[${MOCK_TAG}] ${c.name} Terminal`,
      type: GeofenceType.CIRCLE,
      centerLat: c.lat,
      centerLon: c.lon,
      radiusMi: 1.5,
      polygon: Prisma.JsonNull,
      category: 'TERMINAL',
      alertOnEnter: true,
      alertOnExit: true,
      enabled: true,
      createdAt: DateTime.fromJSDate(from).minus({ months: rng.int(1, 24) }).toJSDate(),
    });
  }
  for (const c of US_CITIES.slice(6, 14)) {
    geofenceRows.push({
      id: randomUUID(),
      name: `[${MOCK_TAG}] ${c.name} Customer Site`,
      type: GeofenceType.CIRCLE,
      centerLat: c.lat + rng.float(-0.05, 0.05),
      centerLon: c.lon + rng.float(-0.05, 0.05),
      radiusMi: 0.5,
      polygon: Prisma.JsonNull,
      category: 'CUSTOMER',
      alertOnEnter: true,
      alertOnExit: false,
      enabled: true,
      createdAt: DateTime.fromJSDate(from).minus({ months: rng.int(1, 18) }).toJSDate(),
    });
  }
  for (let i = 0; i < 4; i++) {
    const c = rng.pick(US_CITIES);
    geofenceRows.push({
      id: randomUUID(),
      name: `[${MOCK_TAG}] ${c.name} Yard ${i + 1}`,
      type: GeofenceType.POLYGON,
      centerLat: null,
      centerLon: null,
      radiusMi: null,
      polygon: {
        type: 'Polygon',
        coordinates: [
          [
            [c.lon - 0.01, c.lat - 0.01],
            [c.lon + 0.01, c.lat - 0.01],
            [c.lon + 0.01, c.lat + 0.01],
            [c.lon - 0.01, c.lat + 0.01],
            [c.lon - 0.01, c.lat - 0.01],
          ],
        ],
      },
      category: 'YARD',
      alertOnEnter: false,
      alertOnExit: true,
      enabled: true,
      createdAt: DateTime.fromJSDate(from).minus({ months: rng.int(1, 12) }).toJSDate(),
    });
  }
  for (let i = 0; i < 3; i++) {
    const c = rng.pick(US_CITIES);
    geofenceRows.push({
      id: randomUUID(),
      name: `[${MOCK_TAG}] Restricted Zone ${i + 1} (${c.name})`,
      type: GeofenceType.CIRCLE,
      centerLat: c.lat + rng.float(-0.2, 0.2),
      centerLon: c.lon + rng.float(-0.2, 0.2),
      radiusMi: rng.float(2, 8),
      polygon: Prisma.JsonNull,
      category: 'RESTRICTED',
      alertOnEnter: true,
      alertOnExit: false,
      enabled: true,
      createdAt: DateTime.fromJSDate(from).minus({ months: rng.int(1, 6) }).toJSDate(),
    });
  }

  // ---- trips: group each driver's driving days into hauls -------------------------------------
  const assignedDrivers = drivers.filter((d) => d.assignedVehicleId);
  for (const driver of assignedDrivers) {
    const usableDays = driverDaysMap.get(driver.id) ?? [];
    let idx = 0;
    while (idx < usableDays.length) {
      const span = rng.int(1, 3);
      const group = usableDays.slice(idx, idx + span);
      idx += span;
      if (group.length === 0) continue;
      const vehicleId = group[0].vehicleId ?? driver.assignedVehicleId!;
      if (!vehicleById.has(vehicleId)) continue;

      const originCity = rng.pick(US_CITIES);
      let destCity = rng.pick(US_CITIES);
      while (destCity.name === originCity.name) destCity = rng.pick(US_CITIES);

      const plannedStartAt = DateTime.fromJSDate(group[0].first).minus({ hours: rng.int(1, 3) });
      const plannedEndAt = DateTime.fromJSDate(group[group.length - 1].last).plus({ hours: rng.int(1, 6) });
      const isLate = rng.chance(0.08);
      const etaAt = isLate ? plannedEndAt.minus({ hours: rng.int(1, 4) }) : plannedEndAt.plus({ minutes: rng.int(-30, 30) });
      const isCancelled = rng.chance(0.04);
      const status = isCancelled ? TripStatus.CANCELLED : TripStatus.DELIVERED;
      const tripId = randomUUID();
      const trailerId = trailers.length && rng.chance(0.7) ? rng.pick(trailers).id : null;

      tripRows.push({
        id: tripId,
        number: `TR-M${tripSeq++}`,
        driverId: driver.id,
        vehicleId,
        trailerId,
        status,
        shippingDocument: `BOL #${rng.int(10000, 99999)}-${rng.pick(['A', 'B', 'C'])}`,
        commodity: rng.pick(['Palletized dry goods', 'Refrigerated produce', 'Building materials', 'Retail merchandise', 'Auto parts', 'Packaged foods']),
        weightLbs: rng.int(8000, 44000),
        pieces: rng.int(1, 26),
        plannedStartAt: clampToNow(plannedStartAt.toJSDate(), ctx),
        plannedEndAt: clampToNow(plannedEndAt.toJSDate(), ctx),
        startedAt: isCancelled ? null : clampToNow(plannedStartAt.toJSDate(), ctx),
        completedAt: isCancelled ? null : clampToNow(plannedEndAt.toJSDate(), ctx),
        etaAt: clampToNow(etaAt.toJSDate(), ctx),
        onTime: isCancelled ? null : !isLate,
        notes: isCancelled ? `[${MOCK_TAG}] Cancelled by dispatch.` : null,
        createdById: opener.id,
        createdAt: clampToNow(plannedStartAt.minus({ days: rng.int(0, 3) }).toJSDate(), ctx),
      });

      tripStopRows.push({
        id: randomUUID(),
        tripId,
        sequence: 1,
        type: StopType.PICKUP,
        name: `${originCity.name}, ${originCity.state} DC`,
        address: `${rng.int(100, 9999)} Industrial Pkwy, ${originCity.name}, ${originCity.state}`,
        latitude: originCity.lat,
        longitude: originCity.lon,
        scheduledAt: clampToNow(plannedStartAt.toJSDate(), ctx),
        arrivedAt: isCancelled ? null : clampToNow(plannedStartAt.toJSDate(), ctx),
        departedAt: isCancelled ? null : clampToNow(plannedStartAt.plus({ minutes: 45 }).toJSDate(), ctx),
        status: isCancelled ? StopStatus.SKIPPED : StopStatus.COMPLETED,
      });
      tripStopRows.push({
        id: randomUUID(),
        tripId,
        sequence: 2,
        type: StopType.DELIVERY,
        name: `${destCity.name}, ${destCity.state} Customer`,
        address: `${rng.int(100, 9999)} Commerce Dr, ${destCity.name}, ${destCity.state}`,
        latitude: destCity.lat,
        longitude: destCity.lon,
        scheduledAt: clampToNow(plannedEndAt.toJSDate(), ctx),
        arrivedAt: isCancelled ? null : clampToNow(etaAt.toJSDate(), ctx),
        departedAt: isCancelled ? null : clampToNow(etaAt.plus({ minutes: 30 }).toJSDate(), ctx),
        status: isCancelled ? StopStatus.SKIPPED : StopStatus.COMPLETED,
      });
    }
  }

  // ---- a handful of trips "right now": planned / assigned / in-progress -----------------------
  const activeVehicles = vehicles.filter((v) => v.status === VehicleStatus.ACTIVE);
  const currentSample = rng.shuffle(assignedDrivers).slice(0, Math.min(20, assignedDrivers.length));
  for (const driver of currentSample) {
    const vehicleId = driver.assignedVehicleId!;
    if (!vehicleById.has(vehicleId)) continue;
    const originCity = rng.pick(US_CITIES);
    let destCity = rng.pick(US_CITIES);
    while (destCity.name === originCity.name) destCity = rng.pick(US_CITIES);
    const status = rng.pick([TripStatus.PLANNED, TripStatus.ASSIGNED, TripStatus.IN_PROGRESS]);
    const plannedStartAt =
      status === TripStatus.IN_PROGRESS ? nowDt.minus({ hours: rng.int(1, 8) }) : nowDt.plus({ hours: rng.int(1, 48) });
    const plannedEndAt = plannedStartAt.plus({ hours: rng.int(6, 30) });
    const tripId = randomUUID();
    tripRows.push({
      id: tripId,
      number: `TR-M${tripSeq++}`,
      driverId: driver.id,
      vehicleId,
      trailerId: trailers.length ? rng.pick(trailers).id : null,
      status,
      shippingDocument: `BOL #${rng.int(10000, 99999)}-D`,
      commodity: rng.pick(['Palletized dry goods', 'Electronics', 'Furniture', 'Packaged foods']),
      weightLbs: rng.int(8000, 44000),
      pieces: rng.int(1, 26),
      plannedStartAt: clampToNow(plannedStartAt.toJSDate(), ctx),
      plannedEndAt: clampToNow(plannedEndAt.toJSDate(), ctx) > to ? plannedEndAt.toJSDate() : clampToNow(plannedEndAt.toJSDate(), ctx),
      startedAt: status === TripStatus.IN_PROGRESS ? clampToNow(plannedStartAt.toJSDate(), ctx) : null,
      completedAt: null,
      etaAt: plannedEndAt.toJSDate() > to ? plannedEndAt.toJSDate() : clampToNow(plannedEndAt.toJSDate(), ctx),
      onTime: null,
      notes: null,
      createdById: opener.id,
      createdAt: clampToNow(nowDt.minus({ days: rng.int(0, 2) }).toJSDate(), ctx),
    });
    tripStopRows.push({
      id: randomUUID(),
      tripId,
      sequence: 1,
      type: StopType.PICKUP,
      name: `${originCity.name}, ${originCity.state} DC`,
      address: `${rng.int(100, 9999)} Industrial Pkwy, ${originCity.name}, ${originCity.state}`,
      latitude: originCity.lat,
      longitude: originCity.lon,
      scheduledAt: plannedStartAt.toJSDate() > to ? plannedStartAt.toJSDate() : clampToNow(plannedStartAt.toJSDate(), ctx),
      arrivedAt: status === TripStatus.IN_PROGRESS ? clampToNow(plannedStartAt.toJSDate(), ctx) : null,
      departedAt: status === TripStatus.IN_PROGRESS ? clampToNow(plannedStartAt.plus({ minutes: 45 }).toJSDate(), ctx) : null,
      status: status === TripStatus.IN_PROGRESS ? StopStatus.COMPLETED : StopStatus.PENDING,
    });
    tripStopRows.push({
      id: randomUUID(),
      tripId,
      sequence: 2,
      type: StopType.DELIVERY,
      name: `${destCity.name}, ${destCity.state} Customer`,
      address: `${rng.int(100, 9999)} Commerce Dr, ${destCity.name}, ${destCity.state}`,
      latitude: destCity.lat,
      longitude: destCity.lon,
      scheduledAt: plannedEndAt.toJSDate() > to ? plannedEndAt.toJSDate() : clampToNow(plannedEndAt.toJSDate(), ctx),
      arrivedAt: null,
      departedAt: null,
      status: StopStatus.PENDING,
    });
  }

  // ---- unassigned loads: PLANNED, no driver/vehicle, scheduled soon ----------------------------
  const unassignedCount = 22;
  for (let i = 0; i < unassignedCount; i++) {
    const originCity = rng.pick(US_CITIES);
    let destCity = rng.pick(US_CITIES);
    while (destCity.name === originCity.name) destCity = rng.pick(US_CITIES);
    const plannedStartAt = nowDt.plus({ hours: rng.int(2, 200) });
    const plannedEndAt = plannedStartAt.plus({ hours: rng.int(6, 40) });
    const tripId = randomUUID();
    tripRows.push({
      id: tripId,
      number: `TR-M${tripSeq++}`,
      driverId: null,
      vehicleId: null,
      trailerId: null,
      status: TripStatus.PLANNED,
      shippingDocument: `BOL #${rng.int(10000, 99999)}-U`,
      commodity: rng.pick(['Palletized dry goods', 'Retail merchandise', 'Auto parts']),
      weightLbs: rng.int(8000, 44000),
      pieces: rng.int(1, 26),
      plannedStartAt: plannedStartAt.toJSDate(),
      plannedEndAt: plannedEndAt.toJSDate(),
      startedAt: null,
      completedAt: null,
      etaAt: null,
      onTime: null,
      notes: `[${MOCK_TAG}] Awaiting driver/vehicle assignment.`,
      createdById: opener.id,
      createdAt: clampToNow(nowDt.minus({ hours: rng.int(1, 48) }).toJSDate(), ctx),
    });
    tripStopRows.push({
      id: randomUUID(),
      tripId,
      sequence: 1,
      type: StopType.PICKUP,
      name: `${originCity.name}, ${originCity.state} DC`,
      address: `${rng.int(100, 9999)} Industrial Pkwy, ${originCity.name}, ${originCity.state}`,
      latitude: originCity.lat,
      longitude: originCity.lon,
      scheduledAt: plannedStartAt.toJSDate(),
      arrivedAt: null,
      departedAt: null,
      status: StopStatus.PENDING,
    });
    tripStopRows.push({
      id: randomUUID(),
      tripId,
      sequence: 2,
      type: StopType.DELIVERY,
      name: `${destCity.name}, ${destCity.state} Customer`,
      address: `${rng.int(100, 9999)} Commerce Dr, ${destCity.name}, ${destCity.state}`,
      latitude: destCity.lat,
      longitude: destCity.lon,
      scheduledAt: plannedEndAt.toJSDate(),
      arrivedAt: null,
      departedAt: null,
      status: StopStatus.PENDING,
    });
  }

  // ---- persist ----------------------------------------------------------------------------
  log(
    `fleet: inserting ${dvirRows.length} dvirs, ${defectRows.length} defects, ${attachmentRows.length} attachments, ` +
      `${workOrderRows.length} work orders, ${maintRows.length} maintenance schedules, ${tripRows.length} trips, ` +
      `${tripStopRows.length} trip stops, ${geofenceRows.length} geofences`,
  );

  await createManyChunked((rows) => prisma.dvir.createMany({ data: rows }), dvirRows);
  await createManyChunked((rows) => prisma.workOrder.createMany({ data: rows }), workOrderRows);
  await createManyChunked((rows) => prisma.defect.createMany({ data: rows }), defectRows);
  await createManyChunked((rows) => prisma.attachment.createMany({ data: rows }), attachmentRows);
  await createManyChunked((rows) => prisma.maintenanceSchedule.createMany({ data: rows }), maintRows);
  await createManyChunked((rows) => prisma.trip.createMany({ data: rows }), tripRows);
  await createManyChunked((rows) => prisma.tripStop.createMany({ data: rows }), tripStopRows);
  await createManyChunked((rows) => prisma.geofence.createMany({ data: rows }), geofenceRows);

  // ---- enforce the out-of-service rule on the vehicles that have an OPEN CRITICAL defect ------
  const oosVehicleIds = [...new Set(defectRows.filter((d) => d.outOfService).map((d) => d.vehicleId))];
  if (oosVehicleIds.length) {
    await prisma.vehicle.updateMany({ where: { id: { in: oosVehicleIds } }, data: { status: VehicleStatus.OUT_OF_SERVICE } });
  }

  // ---- reconcile any OUT_OF_SERVICE mock vehicle that has no OPEN CRITICAL defect this run ----
  // Two ways a mock vehicle can end up here: (a) `core.ts`'s own ~5% baseline "spare/downed unit"
  // assignment (no defect involved by design — see core.ts's docstring), or (b) a STALE escalation
  // from a previous `fleet` run whose critical defect got regenerated away this time (defects are
  // deleted+recreated every run, so a vehicle's OOS-worthiness can change run to run, but we only
  // ever escalated it, never reconciled it back). Both cases need a stable resolution: give the
  // baseline ones an admin-hold reason (carried on `Vehicle.notes`, tagged with MOCK_TAG so it is
  // never confused for a real admin note) so the state is intentional and self-explaining, and
  // reuse the same marker on re-runs to avoid re-labeling forever. A vehicle already carrying that
  // marker keeps it — its "reason" is stable across runs even though the underlying defect churn
  // is not.
  const ADMIN_HOLD_MARKER = `[${MOCK_TAG}] Administrative hold`;
  const ADMIN_HOLD_REASONS = [
    `${ADMIN_HOLD_MARKER} — awaiting DOT reinspection`,
    `${ADMIN_HOLD_MARKER} — awaiting parts for scheduled repair`,
    `${ADMIN_HOLD_MARKER} — scheduled for retirement/sale`,
    `${ADMIN_HOLD_MARKER} — held pending insurance inspection`,
  ];
  const unexplainedOos = await prisma.vehicle.findMany({
    where: {
      unitNumber: { startsWith: MOCK_UNIT_PREFIX },
      status: VehicleStatus.OUT_OF_SERVICE,
      id: { notIn: oosVehicleIds.length ? oosVehicleIds : ['__none__'] },
      OR: [{ notes: null }, { NOT: { notes: { startsWith: ADMIN_HOLD_MARKER } } }],
    },
    select: { id: true },
  });
  for (let i = 0; i < unexplainedOos.length; i++) {
    await prisma.vehicle.update({
      where: { id: unexplainedOos[i].id },
      data: { notes: ADMIN_HOLD_REASONS[i % ADMIN_HOLD_REASONS.length] },
    });
  }
  if (unexplainedOos.length) {
    log(`fleet: labeled ${unexplainedOos.length} unexplained OUT_OF_SERVICE vehicle(s) with an admin-hold reason`);
  }

  // ---- co-driver pairings: only if core did not already create them for mock drivers ----------
  const existingPairings = await prisma.coDriverPairing.count({ where: { primaryDriverId: { in: driverIds } } });
  let pairingsCreated = 0;
  if (existingPairings === 0) {
    log('fleet: core created no co-driver pairings — adding a few');
    const candidates = rng.shuffle(assignedDrivers).slice(0, 6);
    const used = new Set<string>();
    const pairingRows: Array<{ id: string; primaryDriverId: string; coDriverId: string; vehicleId: string; startedAt: Date; endedAt: Date | null }> = [];
    for (const primary of candidates) {
      const co = drivers.find((d) => d.id !== primary.id && !used.has(d.id) && d.status === 'ACTIVE');
      if (!co) continue;
      used.add(primary.id);
      used.add(co.id);
      const startedAt = DateTime.fromJSDate(from).plus({ days: rng.int(0, 120) });
      pairingRows.push({
        id: randomUUID(),
        primaryDriverId: primary.id,
        coDriverId: co.id,
        vehicleId: primary.assignedVehicleId!,
        startedAt: startedAt.toJSDate(),
        endedAt: rng.chance(0.3) ? startedAt.plus({ days: rng.int(5, 60) }).toJSDate() : null,
      });
    }
    if (pairingRows.length) {
      await prisma.coDriverPairing.createMany({ data: pairingRows });
      pairingsCreated = pairingRows.length;
    }
  } else {
    log(`fleet: core already created ${existingPairings} co-driver pairing(s) for mock drivers — leaving as-is`);
  }

  log(`fleet: done — hosAligned=${usedHosAlignment} oosVehicles=${oosVehicleIds.length}`);

  return {
    dvirs: dvirRows.length,
    defects: defectRows.length,
    attachments: attachmentRows.length,
    workOrders: workOrderRows.length,
    maintenanceSchedules: maintRows.length,
    trips: tripRows.length,
    tripStops: tripStopRows.length,
    geofences: geofenceRows.length,
    outOfServiceVehicles: oosVehicleIds.length,
    outOfServiceAdminHoldLabeled: unexplainedOos.length,
    unassignedTrips: unassignedCount,
    coDriverPairingsCreated: pairingsCreated,
    activeVehicles: activeVehicles.length,
  };
}
