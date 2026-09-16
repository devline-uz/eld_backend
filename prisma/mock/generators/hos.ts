/**
 * OneBook ELD — mock generator: hos.
 *
 * Per mock driver, 6 months of duty history (long-haul / regional / local, home time, 34 h
 * restarts, split sleeper, 30-minute breaks, team driving, PC/YM, a minority of deliberately
 * non-compliant shifts), the §395 `EldEvent` records for it, one `DailyLog` per driver-day, and
 * then `HosViolation` rows produced ONLY by the real recalculation path (`HosRecalcService`).
 *
 * Idempotency without ever deleting an `EldEvent` (append-only, §5.5 — decisions.md D-071):
 *   • GENERATE (no events of ours yet): events, headers, recalc pass 1, the §9.3 edits and recalc
 *     pass 2 all run in ONE transaction — the append-only records land completely or not at all.
 *   • REFRESH (our events already exist — uuid prefix `6d6f636b-`): events are left untouched;
 *     `DailyLog` headers are re-derived from the stored events with the real `buildRodsDay`, and
 *     the real recalculation runs again (its violation writes are upserts by design).
 *
 * Pure planning lives in `hos-schedule.ts` / `hos-events.ts` (unit-tested in
 * `hos-schedule.spec.ts`); this file only reads core rows and writes.
 */
import { Logger } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../../src/core/prisma/prisma.service';
import { HosRecalcRepository } from '../../../src/modules/hos-recalc/hos-recalc.repository';
import { HosRecalcService } from '../../../src/modules/hos-recalc/hos-recalc.service';
import { toMobileShape } from '../../../src/modules/hos-state/hos-drift';
import { addDays, dayEnd, dayKey, dayStart } from '../../../src/modules/hos/engine/timezone';
import { HOS_ENGINE_VERSION } from '../../../src/modules/hos/hos.constants';
import type { DutyStatus, HosRuleset } from '../../../src/modules/hos/hos.types';
import { computeHos } from '../../../src/modules/hos/engine/compute-hos';
import { buildRodsDay, type RodsEvent } from '../../../src/modules/logs/rods';
import {
  createRng,
  MOCK_EMAIL_DOMAIN,
  MOCK_UNIT_PREFIX,
  MOCK_USERNAME_PREFIX,
  type MockContext,
  type MockRng,
} from '../context';
import {
  buildDriverEvents,
  buildRoute,
  buildUnidentifiedEvents,
  CORRIDORS,
  corridorsForTimezone,
  findCity,
  HOS_EVENT_UUID_PREFIX,
  metroLoop,
  motionsFromSegments,
  pickUnidentifiedEpisodes,
  planCertifications,
  VehicleMotion,
  type EventRow,
  type Motion,
  type VehicleCtx,
} from './hos-events';
import {
  applyEdits,
  DAY,
  toEngineEvents,
  dailyTotals,
  DEFAULT_RATES,
  effective,
  fastDayKey,
  fastDayStart,
  H,
  M,
  planDriver,
  type EditPlan,
  type Interval,
  type Plan,
  type PlanInput,
  type Profile,
  type Seg,
  type TailTarget,
  type TeamWindow,
} from './hos-schedule';

const BATCH = 5000;
/** Share of the 1.5 GB mock budget this generator may use. */
const BUDGET_BYTES = 500 * 1024 * 1024;
/** Bytes per EldEvent row including its six indexes (conservative estimate for the pre-check). */
const EST_BYTES_PER_EVENT = 620;
const CONCURRENCY = 4;
const ENGINE_TYPES = ['DRIVING_11', 'SHIFT_14', 'BREAK_30', 'CYCLE_70', 'CYCLE_60'] as const;
const TX_TIMEOUT_MS = 90 * 60_000;

const RESOLUTION_NOTES = [
  'Driver coached on 11-hour limit',
  'Detention at shipper documented; coached',
  'Reviewed with driver, break planning retrained',
  'Dispatch error acknowledged; route re-planned',
  'Warning letter issued, driver acknowledged',
  'Adverse weather claimed; documented in file',
];

type Db = PrismaClient | Prisma.TransactionClient;

interface DriverRow {
  id: string;
  username: string;
  status: string;
  homeTerminalName: string;
  homeTerminalTimezone: string;
  hosRuleset: HosRuleset;
  assignedVehicleId: string | null;
  fleetManagerId: string | null;
  allowPersonalConveyance: boolean;
  allowYardMove: boolean;
  adverseDrivingEnabled: boolean;
  shortHaulException: boolean;
  splitSleeperEnabled: boolean;
  appPlatform: string | null;
  registeredAt: Date;
}

interface DriverWork {
  driver: DriverRow;
  rng: MockRng;
  profile: Profile;
  plan: Plan;
  firstKey: string;
  lastKey: string;
}

function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function pool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

const utcDate = (key: string): Date => new Date(`${key}T00:00:00.000Z`);

function recalcService(db: Db): HosRecalcService {
  return new HosRecalcService(new HosRecalcRepository(db as unknown as PrismaService));
}

/** One recalculation per RODS day with `now` at the end of that day — how production accrues. */
async function recalcDay(
  service: HosRecalcService,
  driverId: string,
  tz: string,
  key: string,
  now: number,
): Promise<void> {
  const nowK = Math.min(dayEnd(tz, key).getTime() - 1, now);
  await service.recalculate({ driverId, fromDate: key }, new Date(nowK));
}

// ---------------------------------------------------------------------------------------------

export async function run(ctx: MockContext): Promise<Record<string, number>> {
  const started = Date.now();
  const { prisma } = ctx;
  Logger.overrideLogger(['error', 'warn']);

  const database = await prisma.$queryRawUnsafe<Array<{ db: string }>>(
    'SELECT current_database() AS db',
  );
  if (database[0]?.db !== 'onebook_eld_dev')
    throw new Error('hos: refusing to run outside onebook_eld_dev');

  // MOCK_HOS_DRIVERS=mock_a,mock_b — REFRESH only these drivers (idempotency checks without a
  // full 500k-event pass). GENERATE plans all drivers together (teams, spare units), so a subset
  // is refused there.
  const onlyDrivers = (process.env.MOCK_HOS_DRIVERS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  const drivers = (await prisma.driver.findMany({
    where: onlyDrivers.length
      ? { username: { in: onlyDrivers, startsWith: MOCK_USERNAME_PREFIX } }
      : { username: { startsWith: MOCK_USERNAME_PREFIX } },
    orderBy: { username: 'asc' },
  })) as unknown as DriverRow[];
  if (onlyDrivers.length) {
    ctx.log(`hos: subset mode — ${drivers.length}/${onlyDrivers.length} drivers (${onlyDrivers.join(',')})`);
    if (drivers.length !== onlyDrivers.length)
      throw new Error('hos: MOCK_HOS_DRIVERS names a driver that is not a mock driver');
  }
  const vehicles = await prisma.vehicle.findMany({
    where: { unitNumber: { startsWith: MOCK_UNIT_PREFIX } },
    include: { device: true },
    orderBy: { unitNumber: 'asc' },
  });
  if (drivers.length === 0 || vehicles.length === 0) {
    throw new Error(
      `hos: core mock data missing (drivers=${drivers.length}, vehicles=${vehicles.length}) — run core first`,
    );
  }
  const withDevice = vehicles.filter((v) => v.device).length;
  ctx.log(
    `hos: ${drivers.length} drivers, ${vehicles.length} vehicles (${withDevice} with a device)`,
  );

  const driverIds = drivers.map((d) => d.id);
  const vehicleIds = vehicles.map((v) => v.id);
  const existing = await countOwnEvents(prisma, driverIds, vehicleIds);
  const mode = existing > 0 ? 'refresh' : 'generate';
  ctx.log(`hos: mode=${mode} (existing hos events: ${existing})`);
  if (onlyDrivers.length && mode === 'generate')
    throw new Error('hos: MOCK_HOS_DRIVERS is refresh-only — these drivers have no hos events yet');

  const counts =
    mode === 'generate' ? await generate(ctx, drivers, vehicles) : await refresh(ctx, drivers);
  if (process.env.HOS_MOCK_DRY_RUN)
    return { ...counts, dryRun: 1, runtimeSec: Math.round((Date.now() - started) / 1000) };
  const report = await finish(ctx, drivers);
  return { ...counts, ...report, runtimeSec: Math.round((Date.now() - started) / 1000) };
}

// ---------------------------------------------------------------------------------------------
// GENERATE
// ---------------------------------------------------------------------------------------------

type VehicleWithDevice = Awaited<ReturnType<PrismaClient['vehicle']['findMany']>>[number] & {
  device: { id: string } | null;
};

async function generate(
  ctx: MockContext,
  drivers: DriverRow[],
  vehicles: VehicleWithDevice[],
): Promise<Record<string, number>> {
  const { prisma } = ctx;
  const now = ctx.to.getTime();
  const started = Date.now();
  const driverIds = drivers.map((d) => d.id);

  // Derived, non-append-only leftovers of an earlier attempt. `HosViolation` rows are NEVER
  // deleted (B-064): the real recalculation below upserts them on (driverId, logDate, type), so
  // ids stay stable for Notification/AuditLog references, RESOLVED rows keep their resolution,
  // and a row that no longer applies is AUTO_CLEARED by the engine's own path. Only the
  // dailyLog link is detached, because the headers are rebuilt; `finish()` re-links it.
  await prisma.driverHosSnapshot.deleteMany({ where: { driverId: { in: driverIds } } });
  await prisma.hosViolation.updateMany({
    where: { driverId: { in: driverIds }, dailyLogId: { not: null } },
    data: { dailyLogId: null },
  });
  await prisma.dailyLog.deleteMany({ where: { driverId: { in: driverIds } } });

  const pairings = await prisma.coDriverPairing.findMany({
    where: { primaryDriverId: { in: driverIds }, coDriverId: { in: driverIds } },
  });

  // ---- plan every driver -----------------------------------------------------------------------
  const teamsByDriver = new Map<string, TeamWindow[]>();
  for (const p of pairings) {
    const start = Math.ceil(Math.max(p.startedAt.getTime(), ctx.from.getTime() + 2 * DAY) / 1000) * 1000;
    const end = Math.floor(Math.min(p.endedAt?.getTime() ?? now, now) / 1000) * 1000;
    if (end - start < 2 * DAY) continue;
    for (const [driverId, role] of [
      [p.primaryDriverId, 'A'],
      [p.coDriverId, 'B'],
    ] as const) {
      const list = teamsByDriver.get(driverId) ?? [];
      if (!list.some((w) => w.start < end && start < w.end))
        list.push({ start, end, role, vehicleId: p.vehicleId });
      teamsByDriver.set(driverId, list);
    }
  }

  const assigned = new Set(
    drivers.map((d) => d.assignedVehicleId).filter((id): id is string => !!id),
  );
  const spares = vehicles.filter((v) => !assigned.has(v.id)).map((v) => v.id);
  let spareIndex = 0;

  // Drivers with a unit of their own are planned first, unconstrained. Unassigned drivers share
  // the spare units round-robin (up to three per unit), so each of them is planned AFTER the
  // earlier occupants of its unit and receives their on-duty instants as reservations: the
  // planner never puts two drivers in D on one truck (B-060).
  const busyByVehicle = new Map<string, Interval[]>();
  const reserve = (plan: Plan): void => {
    for (const s of plan.segments) {
      const eff = effective(s.status, s.special);
      if (!s.vehicleId || (eff !== 'D' && eff !== 'ON')) continue;
      const list = busyByVehicle.get(s.vehicleId) ?? [];
      const last = list[list.length - 1];
      if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
      else list.push({ start: s.start, end: s.end });
      busyByVehicle.set(s.vehicleId, list);
    }
  };
  const ordered = [...drivers.filter((d) => d.assignedVehicleId), ...drivers.filter((d) => !d.assignedVehicleId)];
  const works: DriverWork[] = ordered.map((driver) => {
    const rng = createRng(hashSeed(`hos:${driver.username}`));
    const tz = driver.homeTerminalTimezone;
    const teams = teamsByDriver.get(driver.id) ?? [];
    const soloVehicle =
      driver.assignedVehicleId ??
      (spares.length ? spares[spareIndex++ % spares.length] : (teams[0]?.vehicleId ?? null));
    const busy = soloVehicle ? [...(busyByVehicle.get(soloVehicle) ?? [])].sort((a, b) => a.start - b.start) : [];

    let profile: Profile;
    if (driver.shortHaulException) profile = 'LOCAL';
    else if (teams.length || driver.splitSleeperEnabled) profile = 'LONG_HAUL';
    else {
      const x = rng.next();
      profile = x < 0.45 ? 'LONG_HAUL' : x < 0.8 ? 'REGIONAL' : 'LOCAL';
    }

    const hired = driver.registeredAt.getTime();
    const hireUsable = hired > ctx.from.getTime() + DAY && hired < now - 21 * DAY;
    const anchor = hireUsable ? hired : ctx.from.getTime();
    let firstKey = dayKey(tz, new Date(anchor));
    if (fastDayStart(tz, firstKey) < anchor) firstKey = addDays(firstKey, 1);
    const start = fastDayStart(tz, firstKey);

    const active = driver.status === 'ACTIVE';
    const end = active
      ? now
      : Math.min(now - 3 * DAY, start + rng.float(0.35, 0.9) * (now - start));
    let tail: TailTarget | null = null;
    if (active) {
      const x = rng.next();
      const status: DutyStatus = x < 0.34 ? 'D' : x < 0.5 ? 'ON' : x < 0.72 ? 'SB' : 'OFF';
      tail = { status, nearLimit: rng.chance(0.25) };
    }

    const input: PlanInput = {
      profile,
      ruleset: driver.hosRuleset,
      timezone: tz,
      flags: {
        pc: driver.allowPersonalConveyance,
        ym: driver.allowYardMove,
        split: driver.splitSleeperEnabled,
        shortHaul: driver.shortHaulException,
        adverse: driver.adverseDrivingEnabled,
      },
      start,
      end,
      now,
      vehicleId: soloVehicle,
      teams,
      busy,
      tail,
      rates: DEFAULT_RATES,
    };
    const plan = planDriver(rng, input);
    reserve(plan);
    return {
      driver,
      rng,
      profile,
      plan,
      firstKey,
      lastKey: dayKey(tz, new Date(Math.min(end, now))),
    };
  });
  const profiles = works.reduce<Record<string, number>>(
    (acc, w) => ({ ...acc, [w.profile]: (acc[w.profile] ?? 0) + 1 }),
    {},
  );
  ctx.log(
    `hos: planned ${works.length} drivers ${JSON.stringify(profiles)} in ${Date.now() - started}ms`,
  );

  // ---- vehicles: motion model, routes, unidentified driving ------------------------------------
  const mphBase: Record<Profile, number> = { LONG_HAUL: 58, REGIONAL: 53, LOCAL: 34 };
  const motionsByVehicle = new Map<string, Motion[]>();
  const workByVehicle = new Map<string, Array<[number, number]>>();
  const primaryUser = new Map<string, DriverWork>();
  for (const work of works) {
    const mph = (s: Seg): number => mphBase[work.profile] + (Math.floor(s.start / M) % 9) - 4;
    for (const [vid, list] of motionsFromSegments(work.plan.segments, mph)) {
      const target = motionsByVehicle.get(vid) ?? [];
      for (const m of list) target.push(m);
      motionsByVehicle.set(vid, target);
    }
    for (const s of work.plan.segments) {
      if (!s.vehicleId) continue;
      const eff = effective(s.status, s.special);
      if (eff !== 'ON' && eff !== 'D') continue;
      const list = workByVehicle.get(s.vehicleId) ?? [];
      list.push([s.start, s.end]);
      workByVehicle.set(s.vehicleId, list);
    }
    const own = work.driver.assignedVehicleId;
    if (own) primaryUser.set(own, work);
  }
  for (const work of works) {
    for (const s of work.plan.segments)
      if (s.vehicleId && !primaryUser.has(s.vehicleId)) primaryUser.set(s.vehicleId, work);
  }

  const vrng = createRng(hashSeed('hos:vehicles'));
  const unidentified = new Map<string, Array<{ start: number; end: number }>>();
  for (const v of vehicles) {
    if (!vrng.chance(0.18)) continue;
    const busy = (workByVehicle.get(v.id) ?? []).sort((a, b) => a[0] - b[0]);
    const eps = pickUnidentifiedEpisodes(
      vrng,
      busy,
      ctx.from.getTime() + DAY,
      now - H,
      vrng.int(1, 3),
    );
    if (!eps.length) continue;
    unidentified.set(v.id, eps);
    const target = motionsByVehicle.get(v.id) ?? [];
    for (const e of eps) target.push({ ...e, mph: 30 });
    motionsByVehicle.set(v.id, target);
  }

  const vehicleCtx = new Map<string, VehicleCtx>();
  const odometerUpdates: Array<{ id: string; odometerMi: number; engineHours: number }> = [];
  for (const v of vehicles) {
    const motion = new VehicleMotion(motionsByVehicle.get(v.id) ?? []);
    const user = primaryUser.get(v.id);
    const tz = user?.driver.homeTerminalTimezone ?? 'America/New_York';
    const city = findCity(user?.driver.homeTerminalName);
    let route;
    let routeOffsetMi = 0;
    if (user?.profile === 'LOCAL') {
      route = metroLoop(city?.point ?? CORRIDORS[corridorsForTimezone(tz)[0]][0], vrng);
    } else {
      const allowed = corridorsForTimezone(tz);
      const name = city && allowed.includes(city.corridor) ? city.corridor : vrng.pick(allowed);
      route = buildRoute(CORRIDORS[name]);
      routeOffsetMi =
        city && city.corridor === name ? route.cum[city.index] : vrng.float(0, route.length);
    }
    const coreOdo = v.odometerMi;
    const coreHours = Number(v.engineHours);
    const fits = coreOdo >= motion.totalMiles + 5000;
    const baseMi = fits ? coreOdo - motion.totalMiles : vrng.int(95_000, 480_000);
    const baseEngineHours =
      fits && coreHours >= motion.totalHours * 1.3 + 100
        ? coreHours - motion.totalHours * 1.3
        : Math.round(baseMi / 38);
    const finalMi = Math.round(baseMi + motion.totalMiles);
    const finalHours = Number((baseEngineHours + motion.totalHours * 1.3).toFixed(2));
    if (finalMi > coreOdo || finalHours > coreHours) {
      odometerUpdates.push({
        id: v.id,
        odometerMi: Math.max(finalMi, coreOdo),
        engineHours: Math.max(finalHours, coreHours),
      });
    }
    vehicleCtx.set(v.id, {
      id: v.id,
      deviceId: v.device?.id ?? null,
      offsetMi: v.odometerOffsetMi,
      baseMi,
      baseEngineHours,
      motion,
      route,
      routeOffsetMi,
    });
  }

  // ---- build all records in memory (size check BEFORE any insert) ------------------------------
  const dailyLogs: Prisma.DailyLogCreateManyInput[] = [];
  const phase1: EventRow[] = [];
  const phase2: EventRow[] = [];
  const editsByDriver = new Map<string, EditPlan[]>();
  let certified = 0;

  for (const work of works) {
    const { driver, rng, plan, firstKey, lastKey } = work;
    const tz = driver.homeTerminalTimezone;
    const keys: string[] = [];
    for (let k = firstKey; k <= lastKey; k = addDays(k, 1)) keys.push(k);

    const result = buildDriverEvents({
      driverId: driver.id,
      timezone: tz,
      segments: plan.segments,
      edits: plan.edits,
      planCerts: (logins, applied) => planCertifications(rng, tz, keys, logins, applied, now),
      vehicles: vehicleCtx,
      now,
      rng,
    });
    editsByDriver.set(driver.id, result.appliedEdits);
    for (const r of result.rows) (r.phase === 2 ? phase2 : phase1).push(r);

    // DailyLog headers from the corrected timeline, exactly as `buildRodsDay` counts them.
    const final = applyEdits(plan.segments, result.appliedEdits);
    const totals = dailyTotals(final, tz, firstKey, lastKey, now);
    const certByDay = new Map(result.certs.map((c) => [c.date, c]));
    const superseded = new Set(
      result.rows
        .filter((r) => r.recordStatus === 2 && r.supersedesUuid)
        .map((r) => r.supersedesUuid),
    );
    const miles = new Map<string, [number, number]>();
    const edited = new Set<string>();
    for (const r of result.rows) {
      const key = fastDayKey(tz, r.eventDateTime.getTime());
      if (r.recordOrigin === 2 || r.recordOrigin === 3 || r.recordStatus !== 1) edited.add(key);
      if (r.recordStatus !== 1 || superseded.has(r.uuid) || r.totalVehicleMiles === null) continue;
      const mm = miles.get(key);
      miles.set(
        key,
        mm
          ? [Math.min(mm[0], r.totalVehicleMiles), Math.max(mm[1], r.totalVehicleMiles)]
          : [r.totalVehicleMiles, r.totalVehicleMiles],
      );
    }
    for (const key of keys) {
      const t = totals.get(key);
      if (!t) continue;
      const cert = certByDay.get(key);
      const mm = miles.get(key);
      if (cert?.certified) certified += 1;
      dailyLogs.push({
        driverId: driver.id,
        logDate: utcDate(key),
        timezone: tz,
        offDutySec: t.off,
        sleeperSec: t.sb,
        drivingSec: t.d,
        onDutySec: t.on,
        totalDistanceMi: mm ? mm[1] - mm[0] : 0,
        certified: cert?.certified ?? false,
        certifiedAt: cert?.certifiedAt ? new Date(cert.certifiedAt) : null,
        certifiedById: cert ? driver.id : null,
        certifierType: cert ? 'DRIVER' : null,
        certificationCount: cert?.count ?? 0,
        hasEdits: edited.has(key),
      });
    }
  }

  const unidentifiedRows: EventRow[] = [];
  for (const [vid, eps] of unidentified) {
    const v = vehicleCtx.get(vid);
    if (!v) continue;
    const tz = primaryUser.get(vid)?.driver.homeTerminalTimezone ?? 'America/New_York';
    for (const r of buildUnidentifiedEvents(v, eps, tz, now)) unidentifiedRows.push(r);
  }

  const totalEvents = phase1.length + phase2.length + unidentifiedRows.length;
  const estimate = totalEvents * EST_BYTES_PER_EVENT;
  ctx.log(
    `hos: built ${totalEvents} events (${phase2.length} edit records, ${unidentifiedRows.length} unidentified), ${dailyLogs.length} daily logs — estimate ${(estimate / 1048576).toFixed(0)} MB (${Date.now() - started}ms)`,
  );
  if (estimate > BUDGET_BYTES)
    throw new Error(
      `hos: estimated ${(estimate / 1048576).toFixed(0)} MB exceeds the 500 MB budget — nothing inserted`,
    );

  if (process.env.HOS_MOCK_DRY_RUN) {
    // Nothing is written: measure what the real engine will flag, day by day, before and after edits.
    const dry: Record<string, number> = { eldEvents: totalEvents, dailyLogs: dailyLogs.length };
    let flaggedDays = 0;
    for (const work of works) {
      const tz = work.driver.homeTerminalTimezone;
      const final = toEngineEvents(
        applyEdits(work.plan.segments, editsByDriver.get(work.driver.id) ?? []),
      );
      const flagged = new Set<string>();
      let lo = 0;
      let hi = 0;
      for (let key = work.firstKey; key <= work.lastKey; key = addDays(key, 1)) {
        const nowK = Math.min(dayEnd(tz, key).getTime() - 1, now);
        const from = dayStart(tz, addDays(key, -9)).getTime();
        while (lo < final.length && final[lo].at.getTime() < from) lo += 1;
        while (hi < final.length && final[hi].at.getTime() <= nowK) hi += 1;
        const state = computeHos({
          events: final.slice(lo, hi),
          driver: {
            driverId: work.driver.id,
            splitSleeperEnabled: work.driver.splitSleeperEnabled,
            shortHaulException: work.driver.shortHaulException,
            adverseDrivingEnabled: work.driver.adverseDrivingEnabled,
            allowPersonalConveyance: work.driver.allowPersonalConveyance,
            allowYardMove: work.driver.allowYardMove,
          },
          ruleset: work.driver.hosRuleset,
          now: new Date(nowK),
          timezone: tz,
          previousDays: [],
          lastRestartEndedAt: null,
        });
        for (const v of state.violations.filter((x) => x.logDate === key)) {
          dry[v.type] = (dry[v.type] ?? 0) + 1;
          flagged.add(key);
        }
      }
      flaggedDays += flagged.size;
    }
    dry.violationDayPctX100 = Math.round((10000 * flaggedDays) / Math.max(1, dailyLogs.length));
    ctx.log(
      `hos: DRY RUN — engine would flag ${flaggedDays}/${dailyLogs.length} driver-days: ${JSON.stringify(dry)}`,
    );
    return dry;
  }

  const typeCounts = new Map<string, number>();
  const originCounts = new Map<number, number>();
  for (const r of [...phase1, ...phase2, ...unidentifiedRows]) {
    typeCounts.set(
      `${r.eventType}/${r.eventCode}`,
      (typeCounts.get(`${r.eventType}/${r.eventCode}`) ?? 0) + 1,
    );
    originCounts.set(r.recordOrigin, (originCounts.get(r.recordOrigin) ?? 0) + 1);
  }
  ctx.log(
    `hos: event types ${[...typeCounts.entries()]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  );
  ctx.log(
    `hos: record origins ${[...originCounts.entries()]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}; recordStatus=2 ${phase2.filter((r) => r.recordStatus === 2).length}`,
  );

  // ---- write: one transaction, so the append-only ledger never holds a partial run --------------
  await ensurePartitions(prisma, ctx.from, ctx.to);
  const bytesBefore = await eldEventBytes(prisma);
  const mockUsers = await prisma.user.findMany({
    where: { email: { endsWith: MOCK_EMAIL_DOMAIN } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  let resolved = 0;
  let pass1Calls = 0;
  let pass2Calls = 0;

  // Stage 1 — the ELD records and headers, committed together so other generators can start.
  await prisma.$transaction(
    async (tx) => {
      for (const part of chunk(phase1, BATCH))
        await tx.eldEvent.createMany({ data: part.map((r) => toCreate(r, null)) });
      for (const part of chunk(unidentifiedRows, BATCH))
        await tx.eldEvent.createMany({ data: part.map((r) => toCreate(r, null)) });
      for (const part of chunk(dailyLogs, BATCH)) await tx.dailyLog.createMany({ data: part });
    },
    { timeout: TX_TIMEOUT_MS, maxWait: 120_000 },
  );
  ctx.log(
    `hos: COMMITTED ${phase1.length + unidentifiedRows.length} events for ${works.filter((w) => w.plan.segments.length).length} drivers + ${dailyLogs.length} daily logs (${Date.now() - started}ms)`,
  );

  // Stage 2 — violations through the real recalculation, one RODS day at a time.
  const service = recalcService(prisma);
  const t1 = Date.now();
  let done = 0;
  await pool(works, CONCURRENCY, async (work) => {
    const tz = work.driver.homeTerminalTimezone;
    for (let key = work.firstKey; key <= work.lastKey; key = addDays(key, 1)) {
      await recalcDay(service, work.driver.id, tz, key, now);
      pass1Calls += 1;
    }
    done += 1;
    if (done % 25 === 0)
      ctx.log(`hos: recalc pass 1 — ${done}/${works.length} drivers (${Date.now() - t1}ms)`);
  });

  // Stage 3 — the §9.3 edits arrive after the violations they explain were raised.
  await prisma.$transaction(
    async (tx) => {
      const uuids = [
        ...new Set(phase2.map((r) => r.supersedesUuid).filter((u): u is string => !!u)),
      ];
      const idByUuid = new Map<string, bigint>();
      for (const part of chunk(uuids, 1000)) {
        const found = await tx.eldEvent.findMany({
          where: { uuid: { in: part } },
          select: { id: true, uuid: true },
        });
        found.forEach((f) => idByUuid.set(f.uuid, f.id));
      }
      for (const part of chunk(phase2, BATCH)) {
        await tx.eldEvent.createMany({
          data: part.map((r) =>
            toCreate(r, r.supersedesUuid ? (idByUuid.get(r.supersedesUuid) ?? null) : null),
          ),
        });
      }
    },
    { timeout: TX_TIMEOUT_MS, maxWait: 120_000 },
  );
  {
    for (const work of works) {
      const tz = work.driver.homeTerminalTimezone;
      const days = new Set<string>();
      for (const edit of editsByDriver.get(work.driver.id) ?? []) {
        const d0 = dayKey(tz, new Date(edit.start));
        for (let k = 0; k < (edit.kind === 'INSERT_OFF' ? 3 : 2); k += 1) {
          const key = addDays(d0, k);
          if (key <= work.lastKey) days.add(key);
        }
      }
      for (const key of [...days].sort()) {
        await recalcDay(service, work.driver.id, tz, key, now);
        pass2Calls += 1;
      }
    }
    ctx.log(
      `hos: inserted ${phase2.length} edit records; recalc pass 1=${pass1Calls} days, pass 2=${pass2Calls} days`,
    );

    resolved = await resolveOlderViolations(prisma, drivers, now, mockUsers);
  }

  for (const u of odometerUpdates) {
    await prisma.vehicle.update({
      where: { id: u.id },
      data: { odometerMi: u.odometerMi, engineHours: u.engineHours },
    });
  }
  const bytesAfter = await eldEventBytes(prisma);
  ctx.log(`hos: EldEvent partitions grew ${((bytesAfter - bytesBefore) / 1048576).toFixed(1)} MB`);

  return {
    eldEvents: totalEvents,
    editRecords: phase2.length,
    unidentifiedEvents: unidentifiedRows.length,
    dailyLogs: dailyLogs.length,
    certifiedDays: certified,
    resolvedNow: resolved,
    recalcDays: pass1Calls + pass2Calls,
    splitEpisodes: works.reduce((n, w) => n + w.plan.splits.length, 0),
    restarts: works.reduce((n, w) => n + w.plan.restarts, 0),
    vehiclesOdometerRaised: odometerUpdates.length,
    eldEventMB: Math.round((bytesAfter - bytesBefore) / 1048576),
  };
}

/**
 * A share of older violations resolved by a fleet manager (the B-6 resolve flow's end state).
 *
 * Idempotent (B-064): the draw for each row comes from its stable key (driverId, logDate, type),
 * not from one stream over the current OPEN list — so a re-run makes the same decision for the
 * same violation, never re-rolls or re-resolves, and writes by that key. RESOLVED and
 * AUTO_CLEARED rows are never touched; nothing is created or deleted.
 */
export async function resolveOlderViolations(
  db: Db,
  drivers: Array<Pick<DriverRow, 'id' | 'fleetManagerId'>>,
  now: number,
  mockUsers: Array<{ id: string }>,
): Promise<number> {
  const managerOf = new Map(drivers.map((d) => [d.id, d.fleetManagerId]));
  const candidates = await db.hosViolation.findMany({
    where: {
      driverId: { in: drivers.map((d) => d.id) },
      status: 'OPEN',
      occurredAt: { lt: new Date(now - 10 * DAY) },
    },
    select: { driverId: true, logDate: true, type: true, occurredAt: true },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  let resolved = 0;
  for (const v of candidates) {
    const rrng = createRng(hashSeed(`hos:resolve:${v.driverId}:${dayKey('UTC', v.logDate)}:${v.type}`));
    if (!rrng.chance(0.3)) continue;
    const { count } = await db.hosViolation.updateMany({
      where: { driverId: v.driverId, logDate: v.logDate, type: v.type, status: 'OPEN' },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(Math.min(now - H, v.occurredAt.getTime() + rrng.float(0.5, 6) * DAY)),
        resolvedById:
          managerOf.get(v.driverId) ?? (mockUsers.length ? rrng.pick(mockUsers).id : null),
        resolutionNote: rrng.pick(RESOLUTION_NOTES),
      },
    });
    resolved += count;
  }
  return resolved;
}

// ---------------------------------------------------------------------------------------------
// REFRESH — our events already exist; rebuild everything derived from them
// ---------------------------------------------------------------------------------------------

async function refresh(ctx: MockContext, drivers: DriverRow[]): Promise<Record<string, number>> {
  const { prisma } = ctx;
  const now = ctx.to.getTime();
  const service = recalcService(prisma);
  let logs = 0;
  let recalcDays = 0;

  await pool(drivers, CONCURRENCY, async (driver, i) => {
    const tz = driver.homeTerminalTimezone;
    const events = await prisma.eldEvent.findMany({
      where: { driverId: driver.id },
      orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }],
      select: {
        id: true,
        eventType: true,
        eventCode: true,
        eventDateTime: true,
        recordStatus: true,
        recordOrigin: true,
        eventSequenceId: true,
        supersedesId: true,
        totalVehicleMiles: true,
        comment: true,
        receivedAt: true,
      },
    });
    if (!events.length) return;
    const existingLast = await prisma.dailyLog.findFirst({
      where: { driverId: driver.id },
      orderBy: { logDate: 'desc' },
      select: { logDate: true },
    });
    const firstKey = dayKey(tz, events[0].eventDateTime);
    let lastKey =
      driver.status === 'ACTIVE'
        ? dayKey(tz, new Date(now))
        : dayKey(tz, events[events.length - 1].eventDateTime);
    if (existingLast && dayKey('UTC', existingLast.logDate) > lastKey)
      lastKey = dayKey('UTC', existingLast.logDate);

    const certs = new Map<string, { count: number; at: number }>();
    for (const e of events) {
      if (e.eventType !== 4 || !e.comment?.startsWith('certifiedDate=')) continue;
      const date = e.comment.slice('certifiedDate='.length);
      const c = certs.get(date);
      certs.set(date, {
        count: (c?.count ?? 0) + 1,
        at: Math.max(c?.at ?? 0, e.eventDateTime.getTime()),
      });
    }

    const rods: Array<RodsEvent & { receivedAt: Date }> = events.map((e) => ({ ...e }));
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    let lo = 0;
    let hi = 0;
    for (let key = firstKey; key <= lastKey; key = addDays(key, 1)) {
      const from = dayStart(tz, addDays(key, -9)).getTime();
      const to = dayEnd(tz, key).getTime();
      while (lo < rods.length && rods[lo].eventDateTime.getTime() < from) lo += 1;
      while (hi < rods.length && rods[hi].eventDateTime.getTime() < to) hi += 1;
      const day = buildRodsDay(rods.slice(lo, hi), tz, key, new Date(now));
      const cert = certs.get(key);
      const dayFrom = dayStart(tz, key).getTime();
      const lastEdit = rods
        .slice(lo, hi)
        .filter(
          (e) => e.eventType === 1 && e.recordOrigin === 2 && e.eventDateTime.getTime() >= dayFrom,
        )
        .reduce((max, e) => Math.max(max, e.receivedAt.getTime()), 0);
      const data = {
        timezone: tz,
        offDutySec: day.offDutySec,
        sleeperSec: day.sleeperSec,
        drivingSec: day.drivingSec,
        onDutySec: day.onDutySec,
        totalDistanceMi: day.totalDistanceMi,
        hasEdits: day.hasEdits,
        certified: !!cert && lastEdit <= cert.at,
        certifiedAt: cert ? new Date(cert.at) : null,
        certifiedById: cert ? driver.id : null,
        certifierType: cert ? ('DRIVER' as const) : null,
        certificationCount: cert?.count ?? 0,
      };
      ops.push(
        prisma.dailyLog.upsert({
          where: { driverId_logDate: { driverId: driver.id, logDate: utcDate(key) } },
          create: { driverId: driver.id, logDate: utcDate(key), ...data },
          update: data,
        }),
      );
    }
    for (const part of chunk(ops, 200)) await prisma.$transaction(part);
    logs += ops.length;

    for (let key = firstKey; key <= lastKey; key = addDays(key, 1)) {
      await recalcDay(service, driver.id, tz, key, now);
      recalcDays += 1;
    }
    if ((i + 1) % 25 === 0) ctx.log(`hos: refresh — ${i + 1}/${drivers.length} drivers`);
  });

  return { dailyLogsUpserted: logs, recalcDays };
}

// ---------------------------------------------------------------------------------------------
// Both modes: dailyLog links, the app's last HOS state, sequence counters, report
// ---------------------------------------------------------------------------------------------

async function finish(ctx: MockContext, drivers: DriverRow[]): Promise<Record<string, number>> {
  const { prisma } = ctx;
  const now = ctx.to.getTime();
  const driverIds = drivers.map((d) => d.id);

  // Link each violation to its RODS day header (the recalc upsert leaves `dailyLogId` null).
  await prisma.$executeRawUnsafe(
    `UPDATE "HosViolation" v SET "dailyLogId" = l."id" FROM "DailyLog" l
      WHERE v."driverId" = l."driverId" AND v."logDate" = l."logDate" AND v."dailyLogId" IS NULL AND v."driverId" = ANY($1::text[])`,
    driverIds,
  );

  // Sequence counters continue from what is stored, so real ingest never reuses a number.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "EventSequenceCounter" ("key", "lastSequenceId", "updatedAt")
       SELECT COALESCE("driverId", 'unidentified:' || "vehicleId"), max("eventSequenceId"), now() FROM "EldEvent"
        WHERE "uuid" LIKE '${HOS_EVENT_UUID_PREFIX}%' GROUP BY 1
     ON CONFLICT ("key") DO UPDATE SET "lastSequenceId" = GREATEST("EventSequenceCounter"."lastSequenceId", EXCLUDED."lastSequenceId"), "updatedAt" = now()`,
  );

  // The mobile app's last posted state (§8.6) — computed by the server engine a few minutes ago.
  const service = recalcService(prisma);
  const srng = createRng(hashSeed(`hos:snapshots:${Math.floor(now / DAY)}`));
  let snapshots = 0;
  await pool(
    drivers.filter((d) => d.status === 'ACTIVE'),
    CONCURRENCY,
    async (driver) => {
      const computedAt = new Date(now - srng.int(1, 25) * M);
      const current = await service.computeCurrentState(driver.id, computedAt);
      if (!current) return;
      const platform = (driver.appPlatform ?? '').toUpperCase();
      const data = {
        computedAt,
        receivedAt: new Date(computedAt.getTime() + 3000),
        hosEngineVersion: HOS_ENGINE_VERSION,
        appPlatform:
          platform === 'IOS' || platform === 'ANDROID' ? (platform as 'IOS' | 'ANDROID') : null,
        state: toMobileShape(current.state) as unknown as Prisma.InputJsonValue,
        lastComparedAt: null,
        maxDriftSec: null,
        driftAlerted: false,
      };
      await prisma.driverHosSnapshot.upsert({
        where: { driverId: driver.id },
        create: { driverId: driver.id, ...data },
        update: data,
      });
      snapshots += 1;
    },
  );

  const [byType, logStats, sizes, ownEvents] = await Promise.all([
    prisma.hosViolation.groupBy({
      by: ['type', 'status'],
      where: { driverId: { in: driverIds } },
      _count: { _all: true },
    }),
    prisma.$queryRawUnsafe<Array<{ days: bigint; flagged: bigint }>>(
      `SELECT count(*) AS days, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "HosViolation" v WHERE v."driverId" = l."driverId" AND v."logDate" = l."logDate" AND v."type"::text = ANY($2::text[]))) AS flagged
         FROM "DailyLog" l WHERE l."driverId" = ANY($1::text[])`,
      driverIds,
      [...ENGINE_TYPES],
    ),
    tableSizes(prisma),
    prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM "EldEvent" WHERE "uuid" LIKE '${HOS_EVENT_UUID_PREFIX}%'`,
    ),
  ]);
  const days = Number(logStats[0]?.days ?? 0);
  const flagged = Number(logStats[0]?.flagged ?? 0);

  // B-044 / B-054 — nothing this generator owns may be stamped after `now`.
  const future = await prisma.$queryRawUnsafe<Array<{ violations: bigint; events: bigint; logs: bigint }>>(
    `SELECT (SELECT count(*) FROM "HosViolation" WHERE "driverId" = ANY($1::text[]) AND ("occurredAt" > $2 OR "resolvedAt" > $2)) AS violations,
            (SELECT count(*) FROM "EldEvent" WHERE "uuid" LIKE '${HOS_EVENT_UUID_PREFIX}%' AND ("eventDateTime" > $2 OR "createdAt" > $2 OR "receivedAt" > $2)) AS events,
            (SELECT count(*) FROM "DailyLog" l JOIN "Driver" d ON d."id" = l."driverId"
              WHERE l."driverId" = ANY($1::text[]) AND (l."logDate" > ($2::timestamptz AT TIME ZONE d."homeTerminalTimezone")::date OR l."certifiedAt" > $2)) AS logs`,
    driverIds,
    ctx.to,
  );
  const futureRows = Number(future[0]?.violations ?? 0) + Number(future[0]?.events ?? 0) + Number(future[0]?.logs ?? 0);
  if (futureRows > 0) {
    throw new Error(`hos: ${JSON.stringify(future[0], (_k, v) => (typeof v === 'bigint' ? Number(v) : v))} rows are stamped after now`);
  }
  ctx.log(
    `hos: violations ${byType
      .map((g) => `${g.type}:${g.status}=${g._count._all}`)
      .sort()
      .join(' ')}`,
  );
  ctx.log(
    `hos: driver-days with an engine violation ${flagged}/${days} (${days ? ((100 * flagged) / days).toFixed(2) : 0}%)`,
  );
  ctx.log(`hos: sizes ${sizes}`);

  const out: Record<string, number> = {
    hosEventsStored: Number(ownEvents[0]?.n ?? 0),
    dailyLogsStored: days,
    violationDayPctX100: days ? Math.round((10000 * flagged) / days) : 0,
    violations: byType.reduce((n, g) => n + g._count._all, 0),
    snapshots,
  };
  for (const g of byType) out[`${g.type}_${g.status}`] = g._count._all;
  return out;
}

// ---------------------------------------------------------------------------------------------

function toCreate(row: EventRow, supersedesId: bigint | null): Prisma.EldEventCreateManyInput {
  const { supersedesUuid: _uuid, phase: _phase, ...rest } = row;
  void _uuid;
  void _phase;
  return { ...rest, supersedesId } as Prisma.EldEventCreateManyInput;
}

async function countOwnEvents(
  prisma: PrismaClient,
  driverIds: string[],
  vehicleIds: string[],
): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM "EldEvent" WHERE "uuid" LIKE '${HOS_EVENT_UUID_PREFIX}%'
       AND ("driverId" = ANY($1::text[]) OR ("driverId" IS NULL AND "vehicleId" = ANY($2::text[])))`,
    driverIds,
    vehicleIds,
  );
  return Number(rows[0]?.n ?? 0);
}

/** The runtime partition helper ingest itself uses (`IngestRepository.ensurePartitions`). */
async function ensurePartitions(prisma: PrismaClient, from: Date, to: Date): Promise<void> {
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
  while (cursor.getTime() <= to.getTime()) {
    await prisma.$queryRawUnsafe(
      `SELECT ensure_event_partition($1::date)`,
      cursor.toISOString().slice(0, 10),
    );
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
}

async function eldEventBytes(prisma: PrismaClient): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ bytes: bigint | null }>>(
    `SELECT sum(pg_total_relation_size(inhrelid))::bigint AS bytes FROM pg_inherits WHERE inhparent = '"EldEvent"'::regclass`,
  );
  return Number(rows[0]?.bytes ?? 0);
}

async function tableSizes(prisma: PrismaClient): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string; bytes: bigint }>>(
    `SELECT 'EldEvent(all partitions)' AS name, sum(pg_total_relation_size(inhrelid))::bigint AS bytes FROM pg_inherits WHERE inhparent = '"EldEvent"'::regclass
     UNION ALL
     SELECT relname, pg_total_relation_size(oid)::bigint FROM pg_class
      WHERE relname IN ('DailyLog', 'HosViolation', 'DriverHosSnapshot', 'EventSequenceCounter') AND relkind = 'r'`,
  );
  return rows.map((r) => `${r.name}=${(Number(r.bytes) / 1048576).toFixed(1)}MB`).join(' ');
}
