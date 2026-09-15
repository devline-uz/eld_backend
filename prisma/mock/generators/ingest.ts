/**
 * OneBook ELD — mock generator: ingest.
 *
 * Builds on the `hos` generator's EldEvents (driving segments with locations/odometer/vehicle):
 *  - TelemetryPoint fixes along every driving segment (5 min cadence for the last 14 days,
 *    30 min before), idle and parked fixes, and a live tail so GET /live/fleet shows moving,
 *    idling, parked and stale/offline units;
 *  - Device BLE state / heartbeat / backlog for mock vehicles (firmware stays as `core` set it);
 *  - eventType 7 malfunction & diagnostic records (logged + cleared, a few still active);
 *  - DiagnosticTroubleCode history (active + cleared, severity in `description`);
 *  - Vehicle odometer / engine-hour / calibration fields brought in line with the telemetry.
 *
 * Idempotency: TelemetryPoint and DTC rows of mock vehicles are deleted then re-inserted.
 * EldEvent is append-only (UPDATE/DELETE revoked, B-009), so eventType 7 records use
 * deterministic `mock-md-*` uuids and are inserted only when none exist yet (see decisions.md).
 */
import { statfsSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { computeChecksum } from '../../../src/modules/ingest/checksum';
import { EVENT_SEQUENCE_MAX, MALFUNCTION_EVENT_CODE, RECORD_ORIGIN } from '../../../src/modules/ingest/event-codes';
import { createRng, MockContext, MOCK_UNIT_PREFIX, MOCK_USERNAME_PREFIX } from '../context';
import {
  buildDrivingSegments,
  type BusTypeName,
  type CodePlan,
  DAY_MS,
  type DrivingSegment,
  HOUR_MS,
  MIN_MS,
  newVehicleState,
  planCodes,
  planDtcs,
  segmentTelemetry,
  type SourceEvent,
  type TelemetryRowOut,
  type TimelinePoint,
  valueAt,
  type VehicleState,
} from './ingest.helpers';

const BATCH = 5000;
/** Own PRNG stream so this generator's output does not depend on how much `ctx.rng` others used. */
const INGEST_SEED = 0x1a6e57;
const CODE_UUID_PREFIX = 'mock-md-';
/**
 * Only the hos generator's own records drive telemetry and the type-7 odometer: other writers'
 * records on the same trucks (e.g. unidentified-segment reassignment pairs) carry a different
 * mileage base, and mixing them produced 80k-112k mi backwards steps (bugs.md).
 */
const HOS_UUID_PREFIX = '6d6f636b-';
/** Refuse to fabricate a schedule: the hos generator must have produced most drivers' events. */
const MIN_DRIVER_COVERAGE = 0.6;

/** Stop inserting below this much free space on / (Postgres data + WAL live there). */
const MIN_FREE_BYTES = 1.2 * 1024 ** 3;

class DiskLowError extends Error {}

function freeBytes(): number {
  const st = statfsSync('/');
  return Number(st.bavail) * Number(st.bsize);
}

/** Batched insert with a free-disk check before every batch; committed batches stay in place. */
/** FNV-1a — stable 32-bit hash for per-vehicle / per-segment PRNG seeds. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Independent PRNG per (unit, scope). One shared stream made every vehicle's values depend on how
 * many draws earlier vehicles took — and that count depends on `now` (live tail, 14-day cadence
 * boundary, "recent" code branches) — so re-runs were not reproducible (bugs.md).
 */
function rngFor(unit: string, scope: string): ReturnType<typeof createRng> {
  return createRng((hash32(`${unit}:${scope}`) ^ INGEST_SEED) >>> 0);
}

async function chunked<T>(rows: T[], fn: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const free = freeBytes();
    if (free < MIN_FREE_BYTES) throw new DiskLowError(`free disk ${(free / 1024 ** 3).toFixed(2)} GB < 1.2 GB`);
    await fn(rows.slice(i, i + BATCH));
  }
}

export async function run(ctx: MockContext): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  try {
    return await generate(ctx, counts);
  } catch (err) {
    if (!(err instanceof DiskLowError)) throw err;
    ctx.log(`ingest: STOPPED inserting — ${err.message}; committed batches left in place`);
    counts.diskStopped = 1;
    return counts;
  }
}

async function generate(ctx: MockContext, counts: Record<string, number>): Promise<Record<string, number>> {
  const { prisma } = ctx;
  const from = ctx.from.getTime();
  const to = ctx.to.getTime();

  const vehicles = await prisma.vehicle.findMany({
    where: { unitNumber: { startsWith: MOCK_UNIT_PREFIX } },
    orderBy: { unitNumber: 'asc' },
    select: {
      id: true,
      unitNumber: true,
      odometerMi: true,
      odometerOffsetMi: true,
      odometerCalibratedAt: true,
      engineHours: true,
      busType: true,
      activatedAt: true,
      device: { select: { id: true, pairedAt: true } },
      driver: { select: { id: true } },
    },
  });
  const drivers = await prisma.driver.findMany({
    where: { username: { startsWith: MOCK_USERNAME_PREFIX } },
    select: { id: true, assignedVehicleId: true },
  });
  if (!vehicles.length || !drivers.length) {
    throw new Error(`ingest: no mock vehicles (${vehicles.length}) or drivers (${drivers.length}) — run core first.`);
  }
  const vehicleIds = vehicles.map((v) => v.id);
  const driverIds = drivers.map((d) => d.id);
  // MOCK_INGEST_UNITS=M1001,M1002 — generate for every vehicle (identical RNG stream) but write only
  // these units: re-running a subset reproduces the full run's rows for them (idempotency proof
  // without doubling disk usage). eventType 7 records are never inserted in subset mode.
  const onlyUnits = (process.env.MOCK_INGEST_UNITS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  const writeIds = new Set(onlyUnits.length ? vehicles.filter((v) => onlyUnits.includes(v.unitNumber)).map((v) => v.id) : vehicleIds);
  const writeIdList = [...writeIds];
  if (onlyUnits.length) ctx.log(`ingest: subset mode — writing ${writeIds.size} vehicles (${onlyUnits.join(',')})`);

  const covered = await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT COUNT(DISTINCT "driverId") AS n FROM "EldEvent"
    WHERE "driverId" = ANY(${driverIds}::text[]) AND "eventType" = 1 AND "eventCode" = 3`);
  const coveredDrivers = Number(covered[0]?.n ?? 0);
  if (coveredDrivers < drivers.length * MIN_DRIVER_COVERAGE) {
    throw new Error(
      `ingest: only ${coveredDrivers}/${drivers.length} mock drivers have driving EldEvents — run the hos generator first.`,
    );
  }
  ctx.log(`ingest: ${vehicles.length} vehicles, ${coveredDrivers}/${drivers.length} drivers with driving events`);

  // --- 1. own rows out ---------------------------------------------------------------------
  counts.telemetryDeleted = (await prisma.telemetryPoint.deleteMany({ where: { vehicleId: { in: writeIdList } } })).count;
  counts.dtcDeleted = (await prisma.diagnosticTroubleCode.deleteMany({ where: { vehicleId: { in: writeIdList } } })).count;

  // --- 2. DTC history (planned first: telemetry `dtcCount` reads it) -----------------------
  const states = new Map<string, VehicleState>();
  const dtcRows = [];
  for (const v of vehicles) {
    const vr = rngFor(v.unitNumber, 'dtc');
    const state = newVehicleState(v.id, vr, {
      odometer: v.odometerMi,
      engineHours: Number(v.engineHours) || vr.int(3000, 18000),
      busType: (v.busType as BusTypeName | null) ?? null,
    });
    const rows = planDtcs(v.id, vr, from, to);
    state.dtcIntervals = rows.map((r) => [r.firstSeenAt.getTime(), r.clearedAt ? r.clearedAt.getTime() : Infinity]);
    states.set(v.id, state);
    if (writeIds.has(v.id)) dtcRows.push(...rows);
  }
  await chunked(dtcRows, (c) => prisma.diagnosticTroubleCode.createMany({ data: c }));
  counts.dtc = dtcRows.length;
  counts.dtcActive = dtcRows.filter((r) => !r.clearedAt).length;

  // --- 3. driving segments from the hos events ----------------------------------------------
  const segmentsByVehicle = new Map<string, DrivingSegment[]>();
  const latestDuty = new Map<string, { code: number; at: number }>();
  const lastEventAtByVehicle = new Map<string, number>();
  const firstEventAtByVehicle = new Map<string, number>();
  const timelines = new Map<string, { mi: TimelinePoint[]; eh: TimelinePoint[] }>();
  for (const driverId of driverIds) {
    const events = await prisma.eldEvent.findMany({
      where: {
        driverId,
        recordStatus: 1,
        eventType: { in: [1, 2, 5, 6] },
        eventDateTime: { gte: new Date(from - DAY_MS), lte: ctx.to },
      },
      orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }],
      select: {
        uuid: true,
        vehicleId: true,
        eventType: true,
        eventCode: true,
        eventDateTime: true,
        timezoneOffset: true,
        latitude: true,
        longitude: true,
        totalVehicleMiles: true,
        totalEngineHours: true,
      },
    });
    const src: SourceEvent[] = events.filter((e) => e.uuid.startsWith(HOS_UUID_PREFIX)).map((e) => ({
      driverId,
      vehicleId: e.vehicleId,
      eventType: e.eventType,
      eventCode: e.eventCode,
      at: e.eventDateTime.getTime(),
      timezoneOffset: e.timezoneOffset,
      lat: e.latitude === null ? null : Number(e.latitude),
      lon: e.longitude === null ? null : Number(e.longitude),
      miles: e.totalVehicleMiles,
      engineHours: e.totalEngineHours === null ? null : Number(e.totalEngineHours),
    }));
    for (const e of src) {
      if (e.vehicleId && states.has(e.vehicleId)) {
        const tl = timelines.get(e.vehicleId) ?? { mi: [], eh: [] };
        if (e.miles !== null) tl.mi.push({ at: e.at, value: e.miles });
        if (e.engineHours !== null) tl.eh.push({ at: e.at, value: e.engineHours });
        timelines.set(e.vehicleId, tl);
      }
      if (e.eventType === 1) latestDuty.set(driverId, { code: e.eventCode, at: e.at });
      if (e.vehicleId && states.has(e.vehicleId)) {
        lastEventAtByVehicle.set(e.vehicleId, Math.max(lastEventAtByVehicle.get(e.vehicleId) ?? 0, e.at));
        if (!firstEventAtByVehicle.has(e.vehicleId)) firstEventAtByVehicle.set(e.vehicleId, e.at);
      }
    }
    for (const seg of buildDrivingSegments(src, to)) {
      if (!states.has(seg.vehicleId)) continue; // a mock driver on a non-mock truck: never touch it
      const list = segmentsByVehicle.get(seg.vehicleId) ?? [];
      list.push(seg);
      segmentsByVehicle.set(seg.vehicleId, list);
    }
  }
  counts.segments = [...segmentsByVehicle.values()].reduce((s, l) => s + l.length, 0);
  for (const tl of timelines.values()) {
    tl.mi.sort((a, b) => a.at - b.at);
    tl.eh.sort((a, b) => a.at - b.at);
  }

  // Stale units: a handful of currently-driving trucks whose app lost the PT30 40-150 min ago.
  const unitById = new Map(vehicles.map((v) => [v.id, v.unitNumber]));
  const withDevice = new Set(vehicles.filter((v) => v.device).map((v) => v.id));
  const openVehicles = [...segmentsByVehicle.entries()]
    .filter(([id, l]) => withDevice.has(id) && l[l.length - 1]?.open)
    .map(([id]) => id)
    .sort((a, b) => hash32(`${unitById.get(a)}:stale`) - hash32(`${unitById.get(b)}:stale`));
  const staleVehicles = new Map(
    openVehicles
      .slice(0, Math.min(4, Math.floor(openVehicles.length / 6)))
      .map((id) => [id, rngFor(unitById.get(id)!, 'stale').int(40, 150) * MIN_MS]),
  );

  // --- 4. telemetry, per vehicle in time order ------------------------------------------------
  let buffer: TelemetryRowOut[] = [];
  let telemetry = 0;
  const flush = async (): Promise<void> => {
    if (!buffer.length) return;
    const rows = buffer;
    buffer = [];
    await chunked(rows, async (c) => {
      await prisma.telemetryPoint.createMany({ data: c, skipDuplicates: true });
      telemetry += c.length;
      counts.telemetry = telemetry; // committed so far, also reported if the disk guard stops us
    });
  };
  const codePlans: Array<CodePlan & { seg: DrivingSegment }> = [];
  const lastFix = new Map<string, number>();
  for (const v of vehicles) {
    const state = states.get(v.id)!;
    const segs = (segmentsByVehicle.get(v.id) ?? []).sort((a, b) => a.start - b.start);
    // Baseline from the hos events, not from core's Vehicle row, so telemetry odometer/engine
    // hours line up with `totalVehicleMiles` / `totalEngineHours` on the RODS records.
    const firstMiles = segs.flatMap((s) => s.waypoints).find((w) => w.miles !== null)?.miles;
    const firstHours = segs.flatMap((s) => s.waypoints).find((w) => w.engineHours !== null)?.engineHours;
    if (firstMiles !== undefined && firstMiles !== null) state.odometer = firstMiles;
    if (firstHours !== undefined && firstHours !== null) state.engineHours = firstHours;
    for (let i = 0; i < segs.length; i += 1) {
      const seg = segs[i];
      // team trucks: the rest window also ends when the co-driver starts driving
      if (i + 1 < segs.length) seg.restUntil = Math.min(seg.restUntil, segs[i + 1].start);
      const segRows = segmentTelemetry(seg, state, rngFor(v.unitNumber, `seg:${seg.driverId}:${seg.start}`), { to, staleCutMs: seg.open ? staleVehicles.get(v.id) : undefined });
      if (writeIds.has(v.id)) buffer.push(...segRows);
      for (const plan of planCodes(seg, rngFor(v.unitNumber, `codes:${seg.driverId}:${seg.start}`), to)) codePlans.push({ ...plan, seg });
    }
    if (state.lastAt) lastFix.set(v.id, state.lastAt);
    if (buffer.length >= BATCH * 4) await flush();
  }
  await flush();
  counts.telemetry = telemetry;

  // --- 5. eventType 7 malfunction / diagnostic records -----------------------------------------
  const existingCodes = await prisma.eldEvent.count({
    where: { vehicleId: { in: vehicleIds }, eventType: 7, uuid: { startsWith: CODE_UUID_PREFIX } },
  });
  if (onlyUnits.length) {
    counts.codeEventsExisting = existingCodes;
  } else if (existingCodes > 0) {
    ctx.log(`ingest: ${existingCodes} mock eventType 7 records already present (append-only table) — not re-inserted`);
    counts.codeEventsExisting = existingCodes;
  } else {
    const rows = buildCodeEvents(codePlans, timelines, to);
    // per-driver sequence continues from the ingest counter (or the table), assigned once here
    const byDriver = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byDriver.get(r.driverId) ?? [];
      list.push(r);
      byDriver.set(r.driverId, list);
    }
    for (const [driverId, list] of byDriver) {
      const counter = await prisma.eventSequenceCounter.findUnique({ where: { key: driverId } });
      let last = counter?.lastSequenceId;
      if (last === undefined) {
        const agg = await prisma.eldEvent.aggregate({ where: { driverId }, _max: { eventSequenceId: true } });
        last = agg._max.eventSequenceId ?? 0;
      }
      list.sort((a, b) => a.eventDateTime.getTime() - b.eventDateTime.getTime());
      for (const r of list) {
        last = last >= EVENT_SEQUENCE_MAX || last < 1 ? 1 : last + 1;
        r.eventSequenceId = last;
      }
      await prisma.eventSequenceCounter.upsert({
        where: { key: driverId },
        create: { key: driverId, lastSequenceId: last },
        update: { lastSequenceId: last },
      });
    }
    await chunked(rows, (c) => prisma.eldEvent.createMany({ data: c, skipDuplicates: true }));
    counts.codeEvents = rows.length;
  }
  const active = await activeCodeCounts(ctx, vehicleIds);
  counts.malfunctionsActive = active.malfunctions;
  counts.diagnosticsActive = active.diagnostics;

  // --- 6. device state + vehicle odometer ------------------------------------------------------
  const deviceStats = await updateDevicesAndVehicles(ctx, vehicles, writeIds, states, latestDuty, lastFix, lastEventAtByVehicle, firstEventAtByVehicle, staleVehicles);
  Object.assign(counts, deviceStats);
  return counts;
}

type CodeEventRow = Prisma.EldEventCreateManyInput & { driverId: string; eventSequenceId: number; eventDateTime: Date };

function buildCodeEvents(
  plans: Array<CodePlan & { seg: DrivingSegment }>,
  timelines: Map<string, { mi: TimelinePoint[]; eh: TimelinePoint[] }>,
  to: number,
): CodeEventRow[] {
  const rows: CodeEventRow[] = [];
  const make = (plan: CodePlan & { seg: DrivingSegment }, at: number, cleared: boolean): CodeEventRow => {
    const isMalf = plan.kind === 'malfunction';
    const eventCode = isMalf
      ? cleared
        ? MALFUNCTION_EVENT_CODE.MALFUNCTION_CLEARED
        : MALFUNCTION_EVENT_CODE.MALFUNCTION_LOGGED
      : cleared
        ? MALFUNCTION_EVENT_CODE.DIAGNOSTIC_CLEARED
        : MALFUNCTION_EVENT_CODE.DIAGNOSTIC_LOGGED;
    const uuid = `${CODE_UUID_PREFIX}${plan.kind[0]}${plan.code}-${cleared ? 'c' : 'l'}-${plan.seg.vehicleId}-${plan.loggedAt}`;
    // Same odometer / engine-hour base as the surrounding hos records on this truck (bugs.md).
    const tl = timelines.get(plan.seg.vehicleId);
    const totalEngineHours = valueAt(tl?.eh ?? [], at, 2);
    const base = {
      uuid,
      eventType: 7,
      eventCode,
      eventDateTime: new Date(at),
      timezoneOffset: plan.seg.timezoneOffset,
      recordStatus: 1,
      recordOrigin: RECORD_ORIGIN.ELD_AUTOMATIC,
      totalEngineHours,
    };
    return {
      ...base,
      driverId: plan.seg.driverId,
      vehicleId: plan.seg.vehicleId,
      deviceId: null,
      eventSequenceId: 0,
      locationPrecisionMi: 1,
      totalVehicleMiles: valueAt(tl?.mi ?? [], at, 0),
      malfunctionCode: isMalf ? plan.code : null,
      diagnosticCode: isMalf ? null : plan.code,
      annotation: (cleared ? `Cleared: ${plan.reason}` : plan.reason).slice(0, 60),
      checksum: computeChecksum(base),
      receivedAt: new Date(Math.min(to, at + 60_000)),
      createdAt: new Date(Math.min(to, at + 60_000)),
    };
  };
  for (const plan of plans) {
    rows.push(make(plan, plan.loggedAt, false));
    if (plan.clearedAt !== null && plan.clearedAt <= to) rows.push(make(plan, plan.clearedAt, true));
  }
  return rows;
}

async function activeCodeCounts(ctx: MockContext, vehicleIds: string[]): Promise<{ malfunctions: number; diagnostics: number }> {
  const rows = await ctx.prisma.$queryRaw<Array<{ kind: string; n: bigint }>>(Prisma.sql`
    WITH last AS (
      SELECT DISTINCT ON ("vehicleId", COALESCE("malfunctionCode", 'd' || "diagnosticCode"), split_part(uuid, '-', 6))
             "eventCode", "malfunctionCode"
      FROM "EldEvent"
      WHERE "vehicleId" = ANY(${vehicleIds}::text[]) AND "eventType" = 7 AND uuid LIKE ${CODE_UUID_PREFIX + '%'}
      ORDER BY "vehicleId", COALESCE("malfunctionCode", 'd' || "diagnosticCode"), split_part(uuid, '-', 6), "eventDateTime" DESC
    )
    SELECT CASE WHEN "malfunctionCode" IS NOT NULL THEN 'm' ELSE 'd' END AS kind, COUNT(*) AS n
    FROM last WHERE "eventCode" IN (1, 3) GROUP BY 1`);
  const get = (k: string): number => Number(rows.find((r) => r.kind === k)?.n ?? 0);
  return { malfunctions: get('m'), diagnostics: get('d') };
}

type MockVehicle = {
  id: string;
  unitNumber: string;
  odometerOffsetMi: number;
  odometerCalibratedAt: Date | null;
  activatedAt: Date | null;
  device: { id: string; pairedAt: Date | null } | null;
  driver: { id: string } | null;
};

async function updateDevicesAndVehicles(
  ctx: MockContext,
  vehicles: MockVehicle[],
  writeIds: Set<string>,
  states: Map<string, VehicleState>,
  latestDuty: Map<string, { code: number; at: number }>,
  lastFix: Map<string, number>,
  lastEventAt: Map<string, number>,
  firstEventAt: Map<string, number>,
  staleVehicles: Map<string, number>,
): Promise<Record<string, number>> {
  const { prisma } = ctx;
  const to = ctx.to.getTime();
  const stats = { devicesUpdated: 0, bleConnected: 0, bleOutOfRange: 0, bleDisconnected: 0, devicesOfflineDays: 0, devicesBacklog: 0, vehiclesUpdated: 0 };
  const ops: Array<Prisma.PrismaPromise<unknown>> = [];
  for (const v of vehicles) {
    const rng = rngFor(v.unitNumber, 'device');
    const state = states.get(v.id)!;
    const fix = lastFix.get(v.id) ?? null;
    if (v.device) {
      const duty = v.driver ? latestDuty.get(v.driver.id) : undefined;
      const activeDriver = !!duty && to - duty.at < 36 * HOUR_MS;
      let bleState: 'CONNECTED' | 'OUT_OF_RANGE' | 'DISCONNECTED';
      let lastSeen: number | null;
      let stored = 0;
      if (staleVehicles.has(v.id)) {
        bleState = rng.chance(0.5) ? 'OUT_OF_RANGE' : 'DISCONNECTED';
        lastSeen = fix ?? to - staleVehicles.get(v.id)!;
        stored = rng.int(110, 420); // backlog > 100 -> alert.device_backlog
      } else if (activeDriver && (duty!.code === 3 || duty!.code === 4)) {
        bleState = 'CONNECTED';
        lastSeen = to - rng.int(5, 25) * 1000; // periodicConnectedSec = 30
      } else if (activeDriver && duty!.code === 2) {
        bleState = rng.chance(0.6) ? 'CONNECTED' : 'OUT_OF_RANGE';
        lastSeen = bleState === 'CONNECTED' ? to - rng.int(5, 25) * 1000 : Math.min(to, duty!.at + rng.int(1, 20) * MIN_MS);
      } else if (activeDriver) {
        bleState = rng.chance(0.3) ? 'OUT_OF_RANGE' : 'DISCONNECTED';
        lastSeen = Math.min(to, duty!.at + rng.int(1, 15) * MIN_MS);
      } else {
        bleState = 'DISCONNECTED';
        lastSeen = fix ?? lastEventAt.get(v.id) ?? (rng.chance(0.5) ? to - rng.int(3, 20) * DAY_MS : null);
        if (lastSeen !== null && rng.chance(0.15)) stored = rng.int(101, 260);
      }
      if (lastSeen !== null && to - lastSeen > 2 * DAY_MS) stats.devicesOfflineDays += 1;
      if (stored > 100) stats.devicesBacklog += 1;
      stats[bleState === 'CONNECTED' ? 'bleConnected' : bleState === 'OUT_OF_RANGE' ? 'bleOutOfRange' : 'bleDisconnected'] += 1;
      const paired = v.device.pairedAt ?? new Date(Math.min(to, firstEventAt.get(v.id) ?? ctx.from.getTime()) - rng.int(1, 30) * DAY_MS);
      if (writeIds.has(v.id)) ops.push(
        prisma.device.update({
          where: { id: v.device.id },
          data: {
            bleState,
            lastSeenAt: lastSeen === null ? null : new Date(lastSeen),
            lastEventAt: lastEventAt.has(v.id) ? new Date(lastEventAt.get(v.id)!) : null,
            storedEventsCount: stored,
            pairedAt: paired,
          },
        }),
      );
      if (writeIds.has(v.id)) stats.devicesUpdated += 1;
    }
    if (fix !== null && writeIds.has(v.id)) {
      const calibratedAt = v.odometerCalibratedAt ?? v.device?.pairedAt ?? v.activatedAt ?? (firstEventAt.has(v.id) ? new Date(firstEventAt.get(v.id)!) : null);
      ops.push(
        prisma.vehicle.update({
          where: { id: v.id },
          data: {
            odometerMi: state.odometer,
            deviceOdometerMi: state.odometer - v.odometerOffsetMi,
            engineHours: state.engineHours,
            odometerCalibratedAt: calibratedAt,
          },
        }),
      );
      stats.vehiclesUpdated += 1;
    }
  }
  for (let i = 0; i < ops.length; i += 200) await prisma.$transaction(ops.slice(i, i + 200));
  return stats;
}
