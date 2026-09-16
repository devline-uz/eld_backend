/**
 * OneBook ELD — mock generator: compliance.
 *
 * Owns: §395.30 carrier edit requests (PENDING / ACCEPTED / REJECTED) and their application,
 * `UnidentifiedSegment`s (PENDING / ASSIGNED / REJECTED / ANNOTATED) with the assignment and
 * rejection records, re-certification of every RODS day those changes touch, annotations on
 * all of those records, and eRODS `DataTransfer`s with real Appendix A files in MinIO.
 *
 * Builds on `hos`: its duty events, certifications (eventType 4), §9.3 self-edits and
 * unidentified pool records are the base and are never duplicated or invented here.
 *
 * Idempotency. `EldEvent`/`AuditLog` are append-only (UPDATE/DELETE revoked for `eld_dev`, and
 * this generator never lifts that guard): every appended record has a deterministic uuid ending
 * in `c0c0c0` and a re-run skips the ones that exist; audit rows are matched by
 * (action, objectId, occurrence). Mutable rows owned here — `UnidentifiedSegment` tagged `[mock]`,
 * mock drivers' `DataTransfer`s and their `mock/transfers/` objects — are deleted and rebuilt;
 * touched `DailyLog` certification columns are recomputed from the base certifications.
 *
 * Every record transition goes through the production planners (`planEditRequest`,
 * `planAcceptEdit`, `planRejectEdit`), rules (`checkEditProposal`), the production sequence
 * allocator (`IngestRepository.allocateSequenceIds`), checksum and Appendix A file builder.
 */
import { createHash } from 'node:crypto';
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Carrier, Driver, EditorType, Prisma, User, Vehicle } from '@prisma/client';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { MockContext, mockId } from '../context';
import type { PrismaService } from '../../../src/core/prisma/prisma.service';
import { addDays, dayEnd, dayKey, dayStart, offsetMs } from '../../../src/modules/hos/engine/timezone';
import { computeChecksum } from '../../../src/modules/ingest/checksum';
import { HosRecalcRepository } from '../../../src/modules/hos-recalc/hos-recalc.repository';
import { HosRecalcService } from '../../../src/modules/hos-recalc/hos-recalc.service';
import { IngestRepository } from '../../../src/modules/ingest/ingest.repository';
import { planAcceptEdit, planEditRequest, planRejectEdit, type AppendRow } from '../../../src/modules/logs/edit-plan';
import type { Interval } from '../../../src/modules/logs/edit-rules';
import { DUTY_STATUS_BY_CODE, statusInEffectAt, type RodsEvent } from '../../../src/modules/logs/rods';
import { buildOutputFileName } from '../../../src/modules/transfers/filename';
import { buildOutputFile } from '../../../src/modules/transfers/output-file';
import { buildSnapshot } from '../../../src/modules/transfers/snapshot';
import { validateOutputFile } from '../../../src/modules/transfers/validator';
import * as P from './compliance.plan';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Fixed generation horizon so planned instants never depend on the moment the run starts. */
const ANCHOR = new Date('2026-03-14T00:00:00Z');
const HORIZON_DAYS = 184;
/** Latest record eligible as an edit/unidentified candidate — fixed at the first dataset build. */
const CANDIDATE_CUTOFF = new Date('2026-09-14T06:00:00Z');
const TRANSFER_COUNT = 320;
const REQ_SENTINEL = -1n;
const TAG = '[mock]';
const AUDIT_PREFIX = `${TAG} `;
const S3_MOCK_PREFIX = 'mock/transfers/';

type Ref = { ref: string };

interface PlannedEvent {
  key: string;
  driverId: string | null;
  sequenceKey: string;
  timezone: string;
  vehicleId: string | null;
  eventType: number;
  eventCode: number;
  at: Date;
  recordStatus: number;
  recordOrigin: number;
  supersedes: bigint | Ref | null;
  annotation: string | null;
  comment: string | null;
  editedById: string | null;
  editorType: EditorType | null;
  editReason: string | null;
  createdAt: Date;
  lat?: number | null;
  lon?: number | null;
  locationName?: string | null;
  totalVehicleMiles?: number | null;
  totalEngineHours?: number | null;
  wasStoredOnDevice?: boolean;
  /** Changes the driver's duty timeline → `hos.recalc`. */
  affectsDuty?: boolean;
}

interface PlannedAudit {
  actorId: string;
  actorType: EditorType;
  action: string;
  objectType: string;
  objectId: string | Ref;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  detail: string;
  createdAt: Date;
}

interface PlannedSegment {
  id: string;
  source: 'hos' | 'yard' | 'login';
  vehicleId: string;
  startAt: Date;
  endAt: Date;
  distanceMi: number;
  startLocation: string;
  endLocation: string;
  status: P.SegmentStatus;
  assignedDriverId: string | null;
  assignedById: string | null;
  assignedAt: Date | null;
  annotation: string | null;
  eventRefs: Array<bigint | string>;
  fromStoredEvents: boolean;
}

/** A pool record that can be retired/copied: either an existing row (id) or a planned one (key). */
interface PoolRecord {
  ref: bigint | string;
  eventType: number;
  eventCode: number;
  at: Date;
  lat: number | null;
  lon: number | null;
  locationName: string | null;
  totalVehicleMiles: number | null;
  totalEngineHours: number | null;
}

interface DriverState {
  driver: Driver;
  tz: string;
  changesByDay: Map<string, Date[]>;
  usedDays: Set<string>;
  baseCerts: Map<string, Date[]>;
}

const EVENT_SELECT = {
  id: true, uuid: true, vehicleId: true, eventType: true, eventCode: true, eventDateTime: true, recordStatus: true, recordOrigin: true,
  eventSequenceId: true, supersedesId: true, totalVehicleMiles: true, totalEngineHours: true, annotation: true, comment: true, locationName: true, latitude: true,
  longitude: true, wasStoredOnDevice: true,
} as const;

/** The hos generator's uuid group — the only records a truck's odometer timeline is read from. */
const HOS_UUID_PREFIX = '6d6f636b-';

const CITY_COORDS: Record<string, [number, number]> = {
  'Columbus, OH': [39.9612, -82.9988], 'Denver, CO': [39.7392, -104.9903], 'Atlanta, GA': [33.749, -84.388],
  'Los Angeles, CA': [34.0522, -118.2437], 'Dallas, TX': [32.7767, -96.797], 'Houston, TX': [29.7604, -95.3698],
  'Phoenix, AZ': [33.4484, -112.074], 'Chicago, IL': [41.8781, -87.6298], 'Nashville, TN': [36.1627, -86.7816],
  'Memphis, TN': [35.1495, -90.049], 'Indianapolis, IN': [39.7684, -86.1581], 'Albuquerque, NM': [35.0844, -106.6504],
};
const CITY_NAMES = Object.keys(CITY_COORDS);

function cityOf(name: string | null | undefined, fallbackSeed: string): { name: string; lat: number; lon: number } {
  const key = name && CITY_COORDS[name] ? name : CITY_NAMES[P.seedOf(fallbackSeed) % CITY_NAMES.length];
  const [lat, lon] = CITY_COORDS[key];
  return { name: key, lat, lon };
}

function offsetPoint(lat: number, lon: number, miles: number, bearingRad: number): { lat: number; lon: number } {
  const dLat = (miles / 69) * Math.cos(bearingRad);
  const dLon = (miles / (69 * Math.cos((lat * Math.PI) / 180))) * Math.sin(bearingRad);
  return { lat: Number((lat + dLat).toFixed(6)), lon: Number((lon + dLon).toFixed(6)) };
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

// =============================================================================================

export async function run(ctx: MockContext): Promise<Record<string, number>> {
  const { prisma } = ctx;
  const now = ctx.to;
  const startedAt = Date.now();
  const counts: Record<string, number> = {};
  const inc = (k: string, n = 1): void => {
    counts[k] = (counts[k] ?? 0) + n;
  };

  // ---------------------------------------------------------------- load
  const carrier = await prisma.carrier.findUniqueOrThrow({ where: { id: ctx.carrierId } });
  const drivers = await prisma.driver.findMany({ where: { username: { startsWith: 'mock_' } }, orderBy: { username: 'asc' } });
  const vehicles = await prisma.vehicle.findMany({ where: { unitNumber: { startsWith: 'M1' } }, orderBy: { unitNumber: 'asc' } });
  if (!drivers.length || !vehicles.length) throw new Error('compliance: no mock drivers/vehicles — run `core` first.');
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
  const driverByVehicle = new Map(drivers.filter((d) => d.assignedVehicleId).map((d) => [d.assignedVehicleId as string, d]));
  // Odometer/engine-hour timeline per truck from the hos records only (B-060): every record this
  // generator appends reads its miles/hours off this timeline, between its hos neighbours.
  const timelines = await loadVehicleTimelines(ctx, vehicles.map((v) => v.id), now);

  const users = await prisma.user.findMany({ include: { role: true }, orderBy: { email: 'asc' } });
  const perm = (u: (typeof users)[number], key: string): string => String((u.role.permissions as Record<string, unknown> | null)?.[key] ?? 'NONE');
  const requesters = users.filter((u) => ['Fleet Manager', 'Dispatcher', 'Admin'].includes(u.role.name));
  const assigners = users.filter((u) => perm(u, 'hosEdit') === 'FULL');
  const certifiers = users.filter((u) => perm(u, 'hosCertifyOnBehalf') === 'FULL');
  if (!requesters.length || !assigners.length) throw new Error('compliance: no fleet manager/dispatcher/admin users found.');

  // hos readiness — this generator never invents a driver's own duty events.
  const withEvents = await prisma.eldEvent.groupBy({
    by: ['driverId'],
    where: { driverId: { in: drivers.map((d) => d.id) }, eventType: 1, recordStatus: 1 },
    _count: { _all: true },
  });
  const ready = withEvents.filter((row) => row._count._all >= 20).length;
  if (ready < Math.ceil(drivers.length * 0.8)) {
    throw new Error(`compliance: hos data not ready — ${ready}/${drivers.length} mock drivers have duty events. Run \`hos\` first.`);
  }
  const dailyLogs = await prisma.dailyLog.findMany({
    where: { driverId: { in: drivers.map((d) => d.id) } },
    select: { id: true, driverId: true, logDate: true },
  });
  const logByDriverDay = new Map(dailyLogs.map((l) => [`${l.driverId}|${l.logDate.toISOString().slice(0, 10)}`, l.id]));
  const sizeBefore = await tableSizes(ctx);

  // ---------------------------------------------------------------- cleanup (mutable tables only)
  const delSeg = await prisma.unidentifiedSegment.deleteMany({ where: { vehicleId: { in: vehicles.map((v) => v.id) }, startLocation: { contains: TAG } } });
  const delTr = await prisma.dataTransfer.deleteMany({ where: { driverId: { in: drivers.map((d) => d.id) } } });
  ctx.log(`compliance: cleanup segments=${delSeg.count} transfers=${delTr.count}`);

  const stage1: PlannedEvent[] = [];
  const stage2: PlannedEvent[] = [];
  const stage3: PlannedEvent[] = [];
  const audits: PlannedAudit[] = [];
  const segments: PlannedSegment[] = [];
  const states = new Map<string, DriverState>();
  const vehicleDriving = new Map<string, Interval[]>();
  const vehicleUnid = new Map<string, Interval[]>();
  const pushInterval = (map: Map<string, Interval[]>, key: string, i: Interval): void => {
    const list = map.get(key) ?? [];
    list.push(i);
    map.set(key, list);
  };
  const addChange = (st: DriverState, instants: Date[], at: Date): void => {
    for (const key of new Set(instants.map((i) => dayKey(st.tz, i)))) {
      const list = st.changesByDay.get(key) ?? [];
      list.push(at);
      st.changesByDay.set(key, list);
    }
  };
  const dayFree = (st: DriverState, at: Date): boolean => {
    const k = dayKey(st.tz, at);
    return !st.usedDays.has(k) && !st.usedDays.has(addDays(k, -1)) && !st.usedDays.has(addDays(k, 1));
  };
  let sampleAccepted: string | null = null;

  // ---------------------------------------------------------------- per driver: login-forgotten unidentified + §395.30 edits
  for (const driver of drivers) {
    const tz = driver.homeTerminalTimezone;
    const raw = await prisma.eldEvent.findMany({
      where: { driverId: driver.id, eventDateTime: { gte: new Date(ANCHOR.getTime() - 3 * DAY), lte: now } },
      select: EVENT_SELECT,
      orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }],
    });
    // Plan from the base timeline only (hos/ingest), so a re-run produces the same plan.
    const events = raw.filter((e) => !P.isComplianceUuid(e.uuid));
    const timeline = P.buildTimeline(events as RodsEvent[], now);
    const duty = timeline.duty as typeof events;
    const st: DriverState = { driver, tz, changesByDay: new Map(), usedDays: new Set(), baseCerts: new Map() };
    states.set(driver.id, st);

    for (const e of events) {
      const certDate = e.eventType === 4 && e.recordStatus === 1 ? /certifiedDate=(\d{4}-\d{2}-\d{2})/.exec(e.comment ?? '')?.[1] : undefined;
      if (certDate) {
        const list = st.baseCerts.get(certDate) ?? [];
        list.push(e.eventDateTime);
        st.baseCerts.set(certDate, list);
      }
      // Days the hos generator already edited stay untouched here (one edit story per day).
      if (e.eventType === 1 && (e.recordOrigin === 2 || e.recordOrigin === 3 || e.recordStatus !== 1)) st.usedDays.add(dayKey(tz, e.eventDateTime));
    }
    for (const interval of timeline.driving) {
      const rec = duty.find((e) => e.eventCode === 3 && e.eventDateTime.getTime() === interval.startAt.getTime());
      const vid = rec?.vehicleId ?? driver.assignedVehicleId;
      if (vid) pushInterval(vehicleDriving, vid, interval);
    }

    const drvRng = P.rngFor(`driver:${driver.id}`);
    const unidTargets = drvRng.int(1, 5);
    const editTargets = drvRng.int(0, 4);
    // Candidate lists must not grow with the wall clock: a longer list reshuffles every pick and
    // a re-run would append a second, different set of edits/segments (append-only, unremovable).
    const inWindow = (e: (typeof events)[number]): boolean =>
      e.eventDateTime.getTime() >= ANCHOR.getTime() + DAY &&
      e.eventDateTime.getTime() <= Math.min(now.getTime() - 6 * HOUR, CANDIDATE_CUTOFF.getTime());

    // ---- (a) the driver moved the truck before logging in → unidentified, later claimed ------
    const unidCandidates = drvRng.shuffle(
      duty.filter((e, i) => {
        if (i === 0 || !inWindow(e) || (e.eventCode !== 3 && e.eventCode !== 4)) return false;
        const prevStatus = DUTY_STATUS_BY_CODE[duty[i - 1].eventCode];
        const vid = e.vehicleId ?? driver.assignedVehicleId;
        return (prevStatus === 'OFF' || prevStatus === 'SB') && e.eventDateTime.getTime() - duty[i - 1].eventDateTime.getTime() >= 3 * HOUR && !!vid && vehicleById.has(vid);
      }),
    );
    let unidDone = 0;
    for (const R of unidCandidates.slice(0, 40)) {
      if (unidDone >= unidTargets) break;
      if (!dayFree(st, R.eventDateTime)) continue;
      const seed = `login:${R.uuid}`;
      const r = P.rngFor(`seg:${seed}`);
      const road = r.chance(0.3);
      const durMin = road ? r.int(20, 110) : r.int(1, 9);
      const endAt = new Date(R.eventDateTime.getTime() - r.int(2, 20) * MIN);
      const startAt = new Date(endAt.getTime() - durMin * MIN);
      const miles = road ? Math.round((durMin * r.int(35, 55)) / 60) : r.int(0, 1);
      const fromStored = r.chance(0.12);
      const assignDelay = r.int(15, 3 * 24 * 60) * MIN;
      const rejectRoll = r.next();
      const rejectDelay = r.int(60, 5 * 24 * 60) * MIN;
      const byDriver = r.chance(0.45);
      const claim = r.pick(P.UNIDENTIFIED_NOTES.DRIVER_CLAIM);
      const decline = r.pick(P.UNIDENTIFIED_NOTES.DRIVER_DECLINE);
      const assigner = r.pick(assigners);
      const bearing = r.float(0, Math.PI * 2);
      const vehicleId = (R.vehicleId ?? driver.assignedVehicleId) as string;

      const origin = R.latitude !== null && R.longitude !== null
        ? { name: R.locationName ?? cityOf(driver.homeTerminalName, seed).name, lat: Number(R.latitude), lon: Number(R.longitude) }
        : cityOf(driver.homeTerminalName, seed);
      const startPt = offsetPoint(origin.lat, origin.lon, miles, bearing);
      const poolCreated = minDate(new Date(endAt.getTime() + (fromStored ? r.int(2, 30) * HOUR : r.int(1, 5) * MIN)), now);
      const pool = addPoolEvents(stage1, seed, vehicleById.get(vehicleId) as Vehicle, timelines.get(vehicleId) ?? EMPTY_TIMELINE, tz, startAt, endAt, startPt, origin, fromStored, poolCreated);
      pushInterval(vehicleUnid, vehicleId, { startAt, endAt });
      st.usedDays.add(dayKey(tz, R.eventDateTime));
      unidDone += 1;

      const segment = newSegment(`seg:${seed}`, 'login', vehicleId, startAt, endAt, poolMiles(pool), `${road ? `near ${origin.name}` : `${origin.name} yard`} ${TAG}`, `${origin.name} ${TAG}`, pool.map((p) => p.ref), fromStored);
      segments.push(segment);
      const assignedAt = new Date(Math.max(endAt.getTime() + assignDelay, poolCreated.getTime() + 5 * MIN));
      if (assignedAt.getTime() > now.getTime()) continue;
      assignSegment(segment, pool, st, byDriver ? { id: driver.id, type: 'DRIVER' } : { id: assigner.id, type: 'USER' }, byDriver ? claim : null, assignedAt, stage1, stage2, audits, addChange);
      const rejectedAt = new Date(assignedAt.getTime() + rejectDelay);
      if (rejectRoll < 0.12 && rejectedAt.getTime() <= now.getTime()) rejectAssignment(segment, pool.length, st, decline, rejectedAt, stage2, stage3, audits, addChange);
    }

    // ---- (b) §395.30 carrier edit requests ----------------------------------------------------
    const editCandidates = drvRng.shuffle(duty.filter((e) => inWindow(e) && e.eventType === 1 && (e.recordOrigin === 1 || e.recordOrigin === 2)));
    let editsDone = 0;
    for (const t of editCandidates.slice(0, 80)) {
      if (editsDone >= editTargets) break;
      if (!dayFree(st, t.eventDateTime)) continue;
      const r = P.rngFor(`edit:${t.uuid}`);
      const proposal = P.proposeCarrierEdit(timeline, t as RodsEvent, r, now);
      const requestedAt = new Date(t.eventDateTime.getTime() + r.int(6 * 60, 10 * 24 * 60) * MIN);
      const preferManager = r.chance(0.4);
      const requesterPick = r.pick(requesters);
      const decision = P.decideEditOutcome(r, requestedAt, now);
      const acceptNote = r.chance(0.5) ? r.pick(P.DRIVER_ACCEPT_NOTES) : null;
      const rejectNote = r.pick(P.DRIVER_REJECT_NOTES);
      if (!proposal || requestedAt.getTime() > now.getTime() - 5 * MIN) continue;
      const requester = (preferManager && requesters.find((u) => u.id === driver.fleetManagerId)) || requesterPick;

      const base = `edit:${t.uuid}`;
      const req = planEditRequest({ id: t.id, eventType: t.eventType, eventCode: t.eventCode, eventDateTime: t.eventDateTime }, {
        status: proposal.status, startAt: proposal.startAt, endAt: proposal.endAt, annotation: proposal.reason,
      })[0];
      stage1.push({
        key: `${base}:req`, driverId: driver.id, sequenceKey: driver.id, timezone: tz, vehicleId: t.vehicleId, eventType: req.eventType,
        eventCode: req.eventCode, at: req.at, recordStatus: req.recordStatus, recordOrigin: req.recordOrigin, supersedes: t.id,
        annotation: req.annotation, comment: proposal.endAt ? `proposedEnd=${proposal.endAt.toISOString()}` : null,
        editedById: requester.id, editorType: 'USER', editReason: proposal.reason, createdAt: requestedAt,
      });
      audits.push({
        actorId: requester.id, actorType: 'USER', action: 'LOG_EDIT_REQUESTED', objectType: 'EldEvent', objectId: { ref: `${base}:req` },
        after: {
          driverId: driver.id, originalEventId: String(t.id), proposedStatus: proposal.status, proposedStart: proposal.startAt.toISOString(),
          proposedEnd: proposal.endAt?.toISOString() ?? null, reason: proposal.reason,
        },
        detail: `${AUDIT_PREFIX}Carrier edit proposal (49 CFR §395.30) — inert until the driver accepts.`, createdAt: requestedAt,
      });
      st.usedDays.add(dayKey(tz, t.eventDateTime));
      editsDone += 1;
      inc(`editRequest_${decision.outcome}`);
      inc(`editKind_${proposal.kind}`);
      const sentinel = { id: REQ_SENTINEL, eventType: req.eventType, eventCode: req.eventCode, eventDateTime: req.at };
      const common = { driverId: driver.id, sequenceKey: driver.id, timezone: tz, vehicleId: t.vehicleId, editedById: driver.id, editorType: 'DRIVER' as EditorType, sentinelRef: `${base}:req` };

      if (decision.outcome === 'ACCEPTED' && decision.resolvedAt) {
        const rows = planAcceptEdit(sentinel, { id: t.id, eventType: t.eventType, eventCode: t.eventCode, eventDateTime: t.eventDateTime }, {
          status: proposal.status, startAt: proposal.startAt, endAt: proposal.endAt, annotation: proposal.reason,
          statusBeforeTarget: statusInEffectAt(events as RodsEvent[], t.eventDateTime),
          statusAfterInterval: proposal.endAt ? statusInEffectAt(events as RodsEvent[], proposal.endAt) : null,
        });
        pushAppendRows(stage2, rows, `${base}:acc`, { ...common, editReason: acceptNote ?? proposal.reason, createdAt: decision.resolvedAt, affectsDuty: true });
        audits.push({
          actorId: driver.id, actorType: 'DRIVER', action: 'LOG_EDIT_ACCEPTED', objectType: 'EldEvent', objectId: { ref: `${base}:req` },
          before: { recordStatus: 3 }, after: { recordStatus: 1, originalEventId: String(t.id), originalRecordStatus: 2 },
          detail: `${AUDIT_PREFIX}Driver accepted the carrier edit (49 CFR §395.30(c)(1)).`, createdAt: decision.resolvedAt,
        });
        addChange(st, [t.eventDateTime, ...rows.map((row) => row.at)], decision.resolvedAt);
        if (!sampleAccepted && proposal.kind !== 'ANNOTATE_DRIVING') sampleAccepted = `${driver.id} ${dayKey(tz, t.eventDateTime)} ${proposal.kind}`;
      } else if (decision.outcome === 'REJECTED' && decision.resolvedAt) {
        const rows = planRejectEdit(sentinel, rejectNote);
        pushAppendRows(stage2, rows, `${base}:rej`, { ...common, editReason: rejectNote, createdAt: decision.resolvedAt, affectsDuty: false });
        audits.push({
          actorId: driver.id, actorType: 'DRIVER', action: 'LOG_EDIT_REJECTED', objectType: 'EldEvent', objectId: { ref: `${base}:req` },
          before: { recordStatus: 3 }, after: { recordStatus: 4 },
          detail: `${AUDIT_PREFIX}Driver rejected the carrier edit (49 CFR §395.30(c)(1)); the log is unchanged.`, createdAt: decision.resolvedAt,
        });
      }
    }
  }

  // ---------------------------------------------------------------- hos unidentified pool records → segments
  const poolRows = (await prisma.eldEvent.findMany({
    where: { driverId: null, recordOrigin: 4, recordStatus: 1, vehicleId: { in: vehicles.map((v) => v.id) }, eventDateTime: { gte: new Date(ANCHOR.getTime() - 3 * DAY), lte: now } },
    select: EVENT_SELECT,
  })).filter((e) => !P.isComplianceUuid(e.uuid));
  const poolByVehicle = new Map<string, typeof poolRows>();
  for (const e of poolRows) {
    const list = poolByVehicle.get(e.vehicleId as string) ?? [];
    list.push(e);
    poolByVehicle.set(e.vehicleId as string, list);
  }
  for (const vehicle of vehicles) {
    const home = driverByVehicle.get(vehicle.id);
    const st = home ? states.get(home.id) : undefined;
    const tz = home?.homeTerminalTimezone ?? carrier.timezone;
    for (const ep of P.groupPoolEpisodes(poolByVehicle.get(vehicle.id) ?? [])) {
      const first = ep.events[0];
      const seed = `hos:${first.uuid}`;
      const r = P.rngFor(`seg:${seed}`);
      const assignable = !!st && dayFree(st, ep.startAt) && !P.overlapsAny(ep.startAt, ep.endAt, vehicleDriving.get(vehicle.id) ?? []);
      const decision = P.decideSegmentStatus(r, ep.endAt, now, assignable);
      const byDriver = r.chance(0.45);
      const claim = r.pick(P.UNIDENTIFIED_NOTES.DRIVER_CLAIM);
      const decline = r.pick(P.UNIDENTIFIED_NOTES.DRIVER_DECLINE);
      const actor = r.pick(assigners);
      const annotated = r.pick(P.UNIDENTIFIED_NOTES.ANNOTATED);
      const rejectedNote = r.pick(P.UNIDENTIFIED_NOTES.REJECTED_POOL);
      const rejectRoll = r.next();
      const rejectDelay = r.int(60, 5 * 24 * 60) * MIN;
      pushInterval(vehicleUnid, vehicle.id, { startAt: ep.startAt, endAt: ep.endAt });

      const miles = Math.max(0, (num(ep.events[ep.events.length - 1].totalVehicleMiles) ?? 0) - (num(first.totalVehicleMiles) ?? 0));
      const startName = ep.events.find((e) => e.locationName)?.locationName ?? cityOf(home?.homeTerminalName, seed).name;
      const endName = [...ep.events].reverse().find((e) => e.locationName)?.locationName ?? startName;
      const pool: PoolRecord[] = ep.events.map((e) => ({
        ref: e.id, eventType: e.eventType, eventCode: e.eventCode, at: e.eventDateTime, lat: num(e.latitude), lon: num(e.longitude),
        locationName: e.locationName, totalVehicleMiles: e.totalVehicleMiles, totalEngineHours: num(e.totalEngineHours),
      }));
      const segment = newSegment(`seg:${seed}`, 'hos', vehicle.id, ep.startAt, ep.endAt, miles, `${startName} ${TAG}`, `${endName} ${TAG}`, pool.map((p) => p.ref), ep.events.some((e) => e.wasStoredOnDevice));
      segments.push(segment);
      if (!decision.actedAt) continue;

      if (decision.status === 'ASSIGNED' && st) {
        assignSegment(segment, pool, st, byDriver ? { id: st.driver.id, type: 'DRIVER' } : { id: actor.id, type: 'USER' }, byDriver ? claim : null, decision.actedAt, stage1, stage2, audits, addChange);
        st.usedDays.add(dayKey(tz, ep.startAt));
        const rejectedAt = new Date(decision.actedAt.getTime() + rejectDelay);
        if (rejectRoll < 0.12 && rejectedAt.getTime() <= now.getTime()) rejectAssignment(segment, pool.length, st, decline, rejectedAt, stage1, stage2, audits, addChange);
      } else if (decision.status === 'ANNOTATED' || decision.status === 'REJECTED') {
        annotateOrRejectPool(segment, decision.status, decision.status === 'ANNOTATED' ? annotated : rejectedNote, actor, decision.actedAt, audits);
      }
    }
  }

  // ---------------------------------------------------------------- short yard moves (mostly no driver)
  for (const vehicle of vehicles) {
    const home = driverByVehicle.get(vehicle.id);
    const tz = home?.homeTerminalTimezone ?? carrier.timezone;
    const n = P.rngFor(`yard:${vehicle.id}`).int(3, 8);
    for (let i = 0; i < n; i += 1) {
      const seed = `yard:${vehicle.id}:${i}`;
      const r = P.rngFor(`seg:${seed}`);
      const dayOffset = r.int(1, HORIZON_DAYS - 1);
      const minuteOfDay = r.int(0, 24 * 60 - 1);
      const road = r.chance(0.15);
      const durMin = road ? r.int(15, 60) : r.int(1, 8);
      const miles = road ? Math.round((durMin * r.int(30, 50)) / 60) : r.int(0, 1);
      const fromStored = r.chance(0.08);
      const bearing = r.float(0, Math.PI * 2);
      const startAt = new Date(ANCHOR.getTime() + dayOffset * DAY + minuteOfDay * MIN);
      const endAt = new Date(startAt.getTime() + durMin * MIN);
      const decision = P.decideSegmentStatus(r, endAt, now, false);
      const actor = r.pick(assigners);
      const annotated = r.pick(P.UNIDENTIFIED_NOTES.ANNOTATED);
      const rejectedNote = r.pick(P.UNIDENTIFIED_NOTES.REJECTED_POOL);
      if (endAt.getTime() > now.getTime() - 10 * MIN) continue;
      // Unidentified driving cannot overlap the unit being driven by a logged-in driver.
      if (P.overlapsAny(startAt, endAt, [...(vehicleDriving.get(vehicle.id) ?? []), ...(vehicleUnid.get(vehicle.id) ?? [])])) {
        inc('yardSkippedOverlap');
        continue;
      }
      pushInterval(vehicleUnid, vehicle.id, { startAt, endAt });
      const city = cityOf(home?.homeTerminalName, seed);
      const endPt = offsetPoint(city.lat, city.lon, miles, bearing);
      const poolCreated = minDate(new Date(endAt.getTime() + (fromStored ? 6 * HOUR : 3 * MIN)), now);
      const pool = addPoolEvents(stage1, seed, vehicle, timelines.get(vehicle.id) ?? EMPTY_TIMELINE, tz, startAt, endAt, { lat: city.lat, lon: city.lon }, { name: city.name, ...endPt }, fromStored, poolCreated);
      const label = road ? city.name : `${city.name} yard`;
      const segment = newSegment(`seg:${seed}`, 'yard', vehicle.id, startAt, endAt, poolMiles(pool), `${label} ${TAG}`, `${road ? `${miles} mi from ${city.name}` : label} ${TAG}`, pool.map((p) => p.ref), fromStored);
      segments.push(segment);
      const actedAt = decision.actedAt && decision.actedAt.getTime() > poolCreated.getTime() ? decision.actedAt : null;
      if (actedAt && (decision.status === 'ANNOTATED' || decision.status === 'REJECTED')) {
        annotateOrRejectPool(segment, decision.status, decision.status === 'ANNOTATED' ? annotated : rejectedNote, actor, actedAt, audits);
      }
    }
  }
  for (const s of segments) {
    inc(`segment_${s.status}`);
    inc(`segmentSource_${s.source}`);
  }

  // ---------------------------------------------------------------- re-certification of touched days (§9.2)
  const dailyUpdates: Array<{ id: string; certified: boolean; certified_at: string | null; certified_by: string | null; certifier_type: string | null; cnt: number }> = [];
  for (const st of states.values()) {
    for (const [key, changes] of st.changesByDay) {
      const logId = logByDriverDay.get(`${st.driver.id}|${key}`);
      if (!logId) continue;
      const base = st.baseCerts.get(key) ?? [];
      const replay = P.replayCertification(P.rngFor(`cert:${st.driver.id}:${key}`), base, changes, now);
      let lastBy: { id: string; type: EditorType } = { id: st.driver.id, type: 'DRIVER' };
      replay.added.forEach((cert, i) => {
        const index = base.length + i;
        const certifier = cert.onBehalf && certifiers.length ? certifiers[P.seedOf(`${st.driver.id}:${key}:${index}`) % certifiers.length] : null;
        const by = certifier ? { id: certifier.id, type: 'USER' as EditorType } : { id: st.driver.id, type: 'DRIVER' as EditorType };
        lastBy = by;
        stage1.push({
          key: `cert:${st.driver.id}:${key}:${index}`, driverId: st.driver.id, sequenceKey: st.driver.id, timezone: st.tz, vehicleId: st.driver.assignedVehicleId,
          eventType: 4, eventCode: cert.eventCode, at: cert.at, recordStatus: 1, recordOrigin: certifier ? 3 : 2, supersedes: null,
          annotation: `Certified RODS day ${key}`, comment: `certifiedDate=${key}`, editedById: by.id, editorType: by.type,
          editReason: certifier ? 'Certified on behalf of the driver' : null, createdAt: cert.at,
        });
        audits.push({
          actorId: by.id, actorType: by.type, action: certifier ? 'LOG_CERTIFIED_ON_BEHALF' : 'LOG_CERTIFIED', objectType: 'DailyLog', objectId: logId,
          after: { driverId: st.driver.id, date: key, certificationCount: index + 1, eventCode: cert.eventCode, certifierType: by.type },
          detail: certifier
            ? `${AUDIT_PREFIX}Certified on behalf of the driver (hosCertifyOnBehalf = FULL, TZ §9.2 — audit mandatory).`
            : `${AUDIT_PREFIX}Driver re-certification after a log change (49 CFR §395.22(i)).`,
          createdAt: cert.at,
        });
        inc(certifier ? 'recertOnBehalf' : 'recertByDriver');
      });
      dailyUpdates.push({
        id: logId,
        certified: replay.certified,
        certified_at: replay.certifiedAt ? replay.certifiedAt.toISOString() : null,
        certified_by: replay.certified ? lastBy.id : null,
        certifier_type: replay.certified ? lastBy.type : null,
        cnt: replay.certificationCount,
      });
      inc('daysTouched');
      if (base.length && !replay.certified) inc('daysRecertificationRequired');
      if (replay.added.length) inc('daysRecertified');
      if (!base.length) inc('daysTouchedNeverCertified');
    }
  }

  // ---------------------------------------------------------------- write EldEvents
  const repo = new IngestRepository(prisma as unknown as PrismaService);
  const ids = new Map<string, bigint>();
  const recalcFrom = new Map<string, string>();
  for (const [name, rows] of [['stage1', stage1], ['stage2', stage2], ['stage3', stage3]] as const) {
    const { inserted, skipped } = await writeStage(ctx, repo, rows, ids, recalcFrom, timelines);
    inc('eventsInserted', inserted);
    inc('eventsSkippedExisting', skipped);
    ctx.log(`compliance: ${name} rows=${rows.length} inserted=${inserted} skipped=${skipped}`);
  }

  // ---------------------------------------------------------------- segments
  const segData: Prisma.UnidentifiedSegmentCreateManyInput[] = segments.map((s) => ({
    id: s.id, vehicleId: s.vehicleId, startAt: s.startAt, endAt: s.endAt, durationSec: Math.round((s.endAt.getTime() - s.startAt.getTime()) / 1000),
    distanceMi: s.distanceMi, startLocation: s.startLocation, endLocation: s.endLocation, status: s.status, assignedDriverId: s.assignedDriverId,
    assignedById: s.assignedById, assignedAt: s.assignedAt, annotation: s.annotation ? s.annotation.slice(0, 60) : null,
    eventIds: s.eventRefs.map((ref) => (typeof ref === 'bigint' ? ref : resolve(ids, ref))), fromStoredEvents: s.fromStoredEvents,
  }));
  for (const part of chunks(segData, 5000)) await prisma.unidentifiedSegment.createMany({ data: part });

  // ---------------------------------------------------------------- DailyLog certification state of touched days
  for (const part of chunks(dailyUpdates, 5000)) {
    await prisma.$executeRawUnsafe(
      `UPDATE "DailyLog" AS d SET
         "certified" = v.certified, "certifiedAt" = v.certified_at, "certifiedById" = v.certified_by,
         "certifierType" = v.certifier_type::"EditorType", "certificationCount" = v.cnt, "hasEdits" = true
       FROM jsonb_to_recordset($1::jsonb) AS v(id text, certified boolean, certified_at timestamp(3), certified_by text, certifier_type text, cnt int)
       WHERE d.id = v.id`,
      JSON.stringify(part),
    );
  }

  // ---------------------------------------------------------------- eRODS transfers
  audits.push(...(await generateTransfers(ctx, carrier, drivers, now, counts)));

  // ---------------------------------------------------------------- audit log (append-only)
  inc('auditInserted', await writeAudits(ctx, audits, ids));
  counts.auditPlanned = audits.length;

  // ---------------------------------------------------------------- DailyLog totals (B-059)
  // Accepted edits, assignments and segment status changes all move a day's totals, and a
  // status carried past midnight moves the next days' too. The production services rebuild
  // headers through `buildDailyLogHeaders`; this generator does the same, over every mock
  // driver's whole horizon, so a re-run can never leave a stale header behind.
  inc('dailyLogsRebuilt', await rebuildDailyLogHeaders(ctx, drivers, now));

  // ---------------------------------------------------------------- hos.recalc (what the real services enqueue)
  inc('recalcEnqueued', await enqueueRecalc(ctx, recalcFrom));

  if (sampleAccepted) ctx.log(`compliance: sample accepted edit (driverId date kind): ${sampleAccepted}`);
  const sizeAfter = await tableSizes(ctx);
  for (const [table, bytes] of Object.entries(sizeAfter)) {
    counts[`sizeMB_${table}`] = Math.round((bytes / 1_048_576) * 10) / 10;
    counts[`growthMB_${table}`] = Math.round(((bytes - (sizeBefore[table] ?? 0)) / 1_048_576) * 10) / 10;
  }
  counts.runtimeSec = Math.round((Date.now() - startedAt) / 1000);
  return counts;
}

// =============================================================================================
// planning helpers
// =============================================================================================

function newSegment(
  idKey: string, source: PlannedSegment['source'], vehicleId: string, startAt: Date, endAt: Date, distanceMi: number,
  startLocation: string, endLocation: string, eventRefs: Array<bigint | string>, fromStoredEvents: boolean,
): PlannedSegment {
  return {
    id: mockId('compliance-unidentified-segment', idKey), source, vehicleId, startAt, endAt, distanceMi, startLocation, endLocation, status: 'PENDING',
    assignedDriverId: null, assignedById: null, assignedAt: null, annotation: null, eventRefs, fromStoredEvents,
  };
}

const EMPTY_TIMELINE: P.VehicleTimeline = { mi: [], eh: [] };

/** Miles a pool segment's own records account for (0 when the truck has no odometer history). */
function poolMiles(pool: PoolRecord[]): number {
  const first = pool[0]?.totalVehicleMiles;
  const last = pool[pool.length - 1]?.totalVehicleMiles;
  return first === null || first === undefined || last === null || last === undefined ? 0 : Math.max(0, last - first);
}

/**
 * Two unidentified records (D at `startAt`, ON at `endAt`) on the vehicle's own odometer
 * timeline: each reading is interpolated between the hos records surrounding its instant, so
 * the pool never breaks the truck's monotonic odometer (B-060). The planned distance is not
 * forced onto the odometer — inside an idle gap the hos records leave no room for it.
 */
function addPoolEvents(
  stage: PlannedEvent[], seed: string, vehicle: Vehicle, tl: P.VehicleTimeline, tz: string, startAt: Date, endAt: Date, startPt: { lat: number; lon: number },
  endPt: { name: string; lat: number; lon: number }, fromStored: boolean, createdAt: Date,
): PoolRecord[] {
  const startReading = P.readingAt(tl, startAt);
  const endReading = P.readingAt(tl, endAt, startReading);
  const common = {
    driverId: null, sequenceKey: `unidentified:${vehicle.id}`, timezone: tz, vehicleId: vehicle.id, recordStatus: 1, recordOrigin: 4,
    supersedes: null, annotation: null, comment: null, editedById: null, editorType: null, editReason: null, createdAt, wasStoredOnDevice: fromStored,
  };
  const records: PoolRecord[] = [
    { ref: `unid:${seed}:pool:0`, eventType: 1, eventCode: 3, at: startAt, lat: startPt.lat, lon: startPt.lon, locationName: null, ...startReading },
    { ref: `unid:${seed}:pool:1`, eventType: 1, eventCode: 4, at: endAt, lat: endPt.lat, lon: endPt.lon, locationName: endPt.name, ...endReading },
  ];
  for (const rec of records) {
    stage.push({
      ...common, key: rec.ref as string, eventType: rec.eventType, eventCode: rec.eventCode, at: rec.at, lat: rec.lat, lon: rec.lon,
      locationName: rec.locationName, totalVehicleMiles: rec.totalVehicleMiles, totalEngineHours: rec.totalEngineHours,
    });
  }
  return records;
}

type AddChange = (st: DriverState, instants: Date[], at: Date) => void;

/**
 * Mirrors `UnidentifiedService.assign`: an "Inactive — Changed" marker on each pool record
 * (driverId null, origin 4) plus an attributed copy (driver, recordOrigin 1 — never 2).
 * Existing pool rows are stage 1; planned ones must exist first, so their chain is stage 2.
 */
function assignSegment(
  segment: PlannedSegment, pool: PoolRecord[], st: DriverState, actor: { id: string; type: EditorType }, driverNote: string | null,
  assignedAt: Date, stage1: PlannedEvent[], stage2: PlannedEvent[], audits: PlannedAudit[], addChange: AddChange,
): void {
  const annotation = (driverNote ?? `Unidentified driving assigned to ${st.driver.username}`).slice(0, 60);
  pool.forEach((rec, i) => {
    const target = typeof rec.ref === 'bigint' ? stage1 : stage2;
    const supersedes = typeof rec.ref === 'bigint' ? rec.ref : { ref: rec.ref };
    const shared = {
      vehicleId: segment.vehicleId, timezone: st.tz, eventType: rec.eventType, eventCode: rec.eventCode, at: rec.at, supersedes, annotation,
      comment: null, editedById: actor.id, editorType: actor.type, editReason: annotation, createdAt: assignedAt, lat: rec.lat, lon: rec.lon,
      locationName: rec.locationName, totalVehicleMiles: rec.totalVehicleMiles, totalEngineHours: rec.totalEngineHours,
    };
    target.push({ ...shared, key: `${segment.id}:asg:mk:${i}`, driverId: null, sequenceKey: `unidentified:${segment.vehicleId}`, recordStatus: 2, recordOrigin: 4 });
    target.push({ ...shared, key: `${segment.id}:asg:cp:${i}`, driverId: st.driver.id, sequenceKey: st.driver.id, recordStatus: 1, recordOrigin: 1, affectsDuty: true });
  });
  Object.assign(segment, { status: 'ASSIGNED', assignedDriverId: st.driver.id, assignedById: actor.id, assignedAt, annotation });
  audits.push({
    actorId: actor.id, actorType: actor.type, action: 'UNIDENTIFIED_ASSIGNED', objectType: 'UnidentifiedSegment', objectId: segment.id,
    before: { status: 'PENDING', assignedDriverId: null },
    after: { status: 'ASSIGNED', assignedDriverId: st.driver.id, recordOrigin: 1, events: pool.length },
    detail: `${AUDIT_PREFIX}Unidentified driving assigned; recordOrigin stays 1 (TZ §23, §7.4).`, createdAt: assignedAt,
  });
  addChange(st, [segment.startAt, segment.endAt], assignedAt);
}

/**
 * Mirrors `UnidentifiedService.reject` on an assigned segment: copies retired, records back to the
 * pool (origin 4, driverId null). The rows reference the copies, so they go one stage after them.
 */
function rejectAssignment(
  segment: PlannedSegment, n: number, st: DriverState, note: string, rejectedAt: Date, copyStage: PlannedEvent[], target: PlannedEvent[],
  audits: PlannedAudit[], addChange: AddChange,
): void {
  const copies = [...Array(n).keys()].map((i) => `${segment.id}:asg:cp:${i}`);
  copies.forEach((copyKey, i) => {
    const copy = copyStage.find((row) => row.key === copyKey);
    if (!copy) throw new Error(`compliance: planned record ${copyKey} not found`);
    target.push({ ...copy, key: `${segment.id}:rej:mk:${i}`, recordStatus: 2, recordOrigin: 1, supersedes: { ref: copyKey }, annotation: note, editedById: st.driver.id, editorType: 'DRIVER', editReason: note, createdAt: rejectedAt, affectsDuty: true });
    target.push({ ...copy, key: `${segment.id}:rej:pool:${i}`, driverId: null, sequenceKey: `unidentified:${segment.vehicleId}`, recordStatus: 1, recordOrigin: 4, supersedes: { ref: copyKey }, annotation: note, editedById: st.driver.id, editorType: 'DRIVER', editReason: note, createdAt: rejectedAt, affectsDuty: false });
  });
  Object.assign(segment, { status: 'REJECTED', assignedDriverId: null, annotation: note });
  audits.push({
    actorId: st.driver.id, actorType: 'DRIVER', action: 'UNIDENTIFIED_REJECTED', objectType: 'UnidentifiedSegment', objectId: segment.id,
    before: { status: 'ASSIGNED', assignedDriverId: st.driver.id }, after: { status: 'REJECTED', assignedDriverId: null, recordOrigin: 4 },
    detail: `${AUDIT_PREFIX}Assignment rejected; records returned to the unidentified pool (recordOrigin 4, driverId null).`, createdAt: rejectedAt,
  });
  addChange(st, [segment.startAt, segment.endAt], rejectedAt);
}

function annotateOrRejectPool(segment: PlannedSegment, status: 'ANNOTATED' | 'REJECTED', note: string, actor: User, actedAt: Date, audits: PlannedAudit[]): void {
  Object.assign(segment, { status, annotation: note });
  audits.push({
    actorId: actor.id, actorType: 'USER', action: status === 'ANNOTATED' ? 'UNIDENTIFIED_ANNOTATED' : 'UNIDENTIFIED_REJECTED', objectType: 'UnidentifiedSegment',
    objectId: segment.id, before: status === 'ANNOTATED' ? { annotation: null } : { status: 'PENDING' },
    after: status === 'ANNOTATED' ? { annotation: note } : { status: 'REJECTED' },
    detail: status === 'ANNOTATED'
      ? `${AUDIT_PREFIX}Unidentified driving annotated (§5.9).`
      : `${AUDIT_PREFIX}Unidentified driving rejected; the records stay unidentified (recordOrigin 4).`,
    createdAt: actedAt,
  });
}

function pushAppendRows(
  stage: PlannedEvent[], rows: AppendRow[], base: string,
  c: { driverId: string; sequenceKey: string; timezone: string; vehicleId: string | null; editedById: string; editorType: EditorType; editReason: string | null; createdAt: Date; sentinelRef: string; affectsDuty: boolean },
): void {
  rows.forEach((row, i) => {
    stage.push({
      key: `${base}:${row.kind}:${i}`, driverId: c.driverId, sequenceKey: c.sequenceKey, timezone: c.timezone, vehicleId: c.vehicleId,
      eventType: row.eventType, eventCode: row.eventCode, at: row.at, recordStatus: row.recordStatus, recordOrigin: row.recordOrigin,
      supersedes: row.supersedesId === REQ_SENTINEL ? { ref: c.sentinelRef } : row.supersedesId, annotation: row.annotation, comment: null,
      editedById: c.editedById, editorType: c.editorType, editReason: c.editReason, createdAt: c.createdAt, affectsDuty: c.affectsDuty,
    });
  });
}

function resolve(ids: Map<string, bigint>, key: string): bigint {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`compliance: unresolved event reference ${key}`);
  return id;
}

// =============================================================================================
// writers
// =============================================================================================

async function writeStage(
  ctx: MockContext, repo: IngestRepository, rows: PlannedEvent[], ids: Map<string, bigint>, recalcFrom: Map<string, string>,
  timelines: Map<string, P.VehicleTimeline>,
): Promise<{ inserted: number; skipped: number }> {
  const { prisma } = ctx;
  if (!rows.length) return { inserted: 0, skipped: 0 };
  const uuidOf = new Map<string, string>();
  for (const row of rows) {
    if (uuidOf.has(row.key)) throw new Error(`compliance: duplicate planned key ${row.key}`);
    uuidOf.set(row.key, P.mockUuid(`evt:${row.key}`));
  }
  const byUuid = new Map<string, bigint>();
  const lookup = async (uuids: string[]): Promise<void> => {
    for (const part of chunks(uuids, 5000)) {
      const found = await prisma.eldEvent.findMany({ where: { uuid: { in: part } }, select: { id: true, uuid: true } });
      for (const f of found) byUuid.set(f.uuid, f.id);
    }
  };
  await lookup([...uuidOf.values()]);
  const fresh = rows.filter((row) => !byUuid.has(uuidOf.get(row.key) as string));

  const months = [...new Set(fresh.map((row) => `${row.at.toISOString().slice(0, 7)}-01`))];
  await repo.ensurePartitions(prisma as unknown as Prisma.TransactionClient, months);

  const bySeq = new Map<string, PlannedEvent[]>();
  for (const row of fresh) {
    const list = bySeq.get(row.sequenceKey) ?? [];
    list.push(row);
    bySeq.set(row.sequenceKey, list);
  }
  for (const [seqKey, list] of [...bySeq.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const part of chunks(list, 5000)) {
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, `eldseq:${seqKey}`);
          await bumpCounterPastExisting(tx, seqKey);
          const seq = await repo.allocateSequenceIds(tx, seqKey, part.length);
          const data = part.map((row, i) => toCreate(withReading(row, timelines), uuidOf.get(row.key) as string, seq[i], ids, byUuid, uuidOf));
          await tx.eldEvent.createMany({ data, skipDuplicates: true });
        },
        { timeout: 120_000, maxWait: 30_000 },
      );
    }
    for (const row of list) {
      if (!row.affectsDuty || !row.driverId) continue;
      const k = addDays(row.at.toISOString().slice(0, 10), -1);
      const prev = recalcFrom.get(row.driverId);
      recalcFrom.set(row.driverId, prev && prev < k ? prev : k);
    }
  }

  await lookup(fresh.map((row) => uuidOf.get(row.key) as string));
  for (const row of rows) {
    const id = byUuid.get(uuidOf.get(row.key) as string);
    if (id === undefined) throw new Error(`compliance: event ${row.key} was not persisted`);
    ids.set(row.key, id);
  }
  return { inserted: fresh.length, skipped: rows.length - fresh.length };
}

/**
 * `hos` re-creates its events and resets `EventSequenceCounter` to its own maximum, which would
 * hand out `eventSequenceId`s already carried by records appended here. The counter is moved past
 * the highest id actually on the table for the key before the real allocator runs (same lock).
 */
async function bumpCounterPastExisting(tx: Prisma.TransactionClient, key: string): Promise<void> {
  const isPool = key.startsWith('unidentified:');
  const rows = await tx.$queryRawUnsafe<Array<{ max: number | null }>>(
    isPool
      ? `SELECT max("eventSequenceId")::int AS max FROM "EldEvent" WHERE "driverId" IS NULL AND "vehicleId" = $1`
      : `SELECT max("eventSequenceId")::int AS max FROM "EldEvent" WHERE "driverId" = $1`,
    isPool ? key.slice('unidentified:'.length) : key,
  );
  const max = rows[0]?.max;
  if (max === null || max === undefined) return;
  const counter = await tx.eventSequenceCounter.findUnique({ where: { key } });
  if (!counter || counter.lastSequenceId < max) {
    await tx.eventSequenceCounter.upsert({ where: { key }, create: { key, lastSequenceId: max }, update: { lastSequenceId: max } });
  }
}

/**
 * Rows planned without a reading (edit-request chains, certifications) get the truck's
 * interpolated odometer/engine hours at their instant, like every other compliance record.
 */
function withReading(row: PlannedEvent, timelines: Map<string, P.VehicleTimeline>): PlannedEvent {
  if (!row.vehicleId || (row.totalVehicleMiles !== undefined && row.totalEngineHours !== undefined)) return row;
  const reading = P.readingAt(timelines.get(row.vehicleId) ?? EMPTY_TIMELINE, row.at);
  return {
    ...row,
    totalVehicleMiles: row.totalVehicleMiles === undefined ? reading.totalVehicleMiles : row.totalVehicleMiles,
    totalEngineHours: row.totalEngineHours === undefined ? reading.totalEngineHours : row.totalEngineHours,
  };
}

/** hos readings per truck, ordered and made monotone (see `P.buildVehicleTimeline`). */
async function loadVehicleTimelines(ctx: MockContext, vehicleIds: string[], now: Date): Promise<Map<string, P.VehicleTimeline>> {
  const out = new Map<string, P.VehicleTimeline>();
  for (const part of chunks(vehicleIds, 25)) {
    const rows = await ctx.prisma.eldEvent.findMany({
      where: { vehicleId: { in: part }, recordStatus: 1, uuid: { startsWith: HOS_UUID_PREFIX }, totalVehicleMiles: { not: null }, eventDateTime: { lte: now } },
      select: { vehicleId: true, eventDateTime: true, totalVehicleMiles: true, totalEngineHours: true },
    });
    const byVehicle = new Map<string, Array<{ at: Date; miles: number | null; engineHours: number | null }>>();
    for (const r of rows) {
      const list = byVehicle.get(r.vehicleId as string) ?? [];
      list.push({ at: r.eventDateTime, miles: r.totalVehicleMiles, engineHours: num(r.totalEngineHours) });
      byVehicle.set(r.vehicleId as string, list);
    }
    for (const [vehicleId, list] of byVehicle) out.set(vehicleId, P.buildVehicleTimeline(list));
  }
  return out;
}

function toCreate(
  row: PlannedEvent, uuid: string, eventSequenceId: number, ids: Map<string, bigint>, byUuid: Map<string, bigint>, uuidOf: Map<string, string>,
): Prisma.EldEventCreateManyInput {
  const timezoneOffset = Math.round(offsetMs(row.timezone, row.at) / 60_000);
  const latitude = row.lat ?? null;
  const longitude = row.lon ?? null;
  const base = {
    uuid, eventType: row.eventType, eventCode: row.eventCode, eventDateTime: row.at, timezoneOffset, recordStatus: row.recordStatus,
    recordOrigin: row.recordOrigin, latitude, longitude, rawDeviceOdometerKm: null, totalEngineHours: row.totalEngineHours ?? null,
  };
  let supersedesId: bigint | null = null;
  if (typeof row.supersedes === 'bigint') supersedesId = row.supersedes;
  else if (row.supersedes) supersedesId = ids.get(row.supersedes.ref) ?? byUuid.get(uuidOf.get(row.supersedes.ref) ?? '') ?? resolve(ids, row.supersedes.ref);
  return {
    ...base, driverId: row.driverId, vehicleId: row.vehicleId, deviceId: null, eventSequenceId, locationPrecisionMi: 1,
    locationName: row.locationName ?? null, totalVehicleMiles: row.totalVehicleMiles ?? null, annotation: row.annotation ? row.annotation.slice(0, 60) : null,
    comment: row.comment, supersedesId, editedById: row.editedById, editorType: row.editorType, editReason: row.editReason,
    wasStoredOnDevice: row.wasStoredOnDevice ?? false, receivedAt: row.createdAt, createdAt: row.createdAt, checksum: computeChecksum(base),
  };
}

/** AuditLog is append-only too: insert only the (action, objectId) occurrences not yet present. */
async function writeAudits(ctx: MockContext, audits: PlannedAudit[], ids: Map<string, bigint>): Promise<number> {
  const { prisma } = ctx;
  const actions = [...new Set(audits.map((a) => a.action))];
  const existing = await prisma.auditLog.groupBy({
    by: ['action', 'objectId'],
    where: { action: { in: actions }, detail: { startsWith: AUDIT_PREFIX } },
    _count: { _all: true },
  });
  const have = new Map(existing.map((e) => [`${e.action}|${e.objectId}`, e._count._all]));
  const sorted = audits
    .map((a) => ({ ...a, objectId: typeof a.objectId === 'string' ? a.objectId : String(resolve(ids, a.objectId.ref)) }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const used = new Map<string, number>();
  const data: Prisma.AuditLogCreateManyInput[] = [];
  for (const a of sorted) {
    const k = `${a.action}|${a.objectId}`;
    const n = (used.get(k) ?? 0) + 1;
    used.set(k, n);
    if (n <= (have.get(k) ?? 0)) continue;
    data.push({
      actorId: a.actorId, actorType: a.actorType, action: a.action, objectType: a.objectType, objectId: a.objectId, before: a.before, after: a.after,
      detail: a.detail, ip: null, userAgent: 'onebook-mock/compliance', createdAt: a.createdAt,
    });
  }
  for (const part of chunks(data, 5000)) await prisma.auditLog.createMany({ data: part });
  return data.length;
}

async function generateTransfers(ctx: MockContext, carrier: Carrier, drivers: Driver[], now: Date, counts: Record<string, number>): Promise<PlannedAudit[]> {
  const { prisma } = ctx;
  const inc = (k: string, n = 1): void => {
    counts[k] = (counts[k] ?? 0) + n;
  };
  const s3 = makeS3();
  let s3Ok = Boolean(s3);
  if (s3) {
    try {
      await clearMockObjects(s3.client, s3.bucket, s3.withPrefix(S3_MOCK_PREFIX));
    } catch (err) {
      ctx.log(`compliance: MinIO unavailable (${(err as Error).message}) — transfer rows keep mock keys without objects`);
      s3Ok = false;
    }
  }

  interface Draft { i: number; driver: Driver; createdAt: Date; method: P.TransferMethodName; dayCount: number; comment: string; byDriver: boolean; outcome: P.TransferOutcome }
  const drafts: Draft[] = [];
  for (let i = 0; i < TRANSFER_COUNT; i += 1) {
    const r = P.rngFor(`transfer:${i}`);
    const driver = r.pick(drivers);
    const offsetMin = r.int(0, (HORIZON_DAYS - 9) * 24 * 60);
    const recentMin = r.int(2, 15);
    const createdAt = i >= TRANSFER_COUNT - 3 ? new Date(now.getTime() - recentMin * MIN) : new Date(ANCHOR.getTime() + 9 * DAY + offsetMin * MIN);
    const method: P.TransferMethodName = r.chance(0.3) ? 'EMAIL' : 'WEB_SERVICES';
    const dayCount = r.chance(0.85) ? 8 : r.int(1, 7);
    const comment = P.routingComment(r);
    const byDriver = r.chance(0.6);
    const outcome = P.decideTransferOutcome(r, method, createdAt, now);
    if (createdAt.getTime() > now.getTime() - MIN) continue;
    drafts.push({ i, driver, createdAt, method, dayCount, comment, byDriver, outcome });
  }
  drafts.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const perDay = new Map<string, number>();
  const rows: Prisma.DataTransferCreateManyInput[] = [];
  const audits: PlannedAudit[] = [];
  let loggedInvalid = false;
  for (const d of drafts) {
    const tz = d.driver.homeTerminalTimezone;
    const endKey = dayKey(tz, d.createdAt);
    const startKey = addDays(endKey, -(d.dayCount - 1));
    const from = dayStart(tz, startKey);
    const to = minDate(dayEnd(tz, endKey), d.createdAt);
    const [allEvents, unidentified, logs] = await Promise.all([
      prisma.eldEvent.findMany({ where: { driverId: d.driver.id, eventDateTime: { gte: from, lte: to } }, orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }] }),
      prisma.eldEvent.findMany({ where: { driverId: null, recordOrigin: 4, eventDateTime: { gte: from, lte: to } }, orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }] }),
      prisma.dailyLog.findMany({ where: { driverId: d.driver.id, logDate: { gte: new Date(`${startKey}T00:00:00Z`), lte: new Date(`${endKey}T00:00:00Z`) } }, orderBy: { logDate: 'asc' } }),
    ]);
    // A file generated at `createdAt` cannot contain records this generator appended later.
    const events = allEvents.filter((e) => !(P.isComplianceUuid(e.uuid) && e.createdAt.getTime() > d.createdAt.getTime()));
    const pool = unidentified.filter((e) => !(P.isComplianceUuid(e.uuid) && e.createdAt.getTime() > d.createdAt.getTime()));
    const vehicleIds = [...new Set([...events, ...pool].map((e) => e.vehicleId).filter((v): v is string => Boolean(v)))];
    if (d.driver.assignedVehicleId) vehicleIds.push(d.driver.assignedVehicleId);
    const editorIds = [...new Set(events.map((e) => e.editedById).filter((v): v is string => Boolean(v)))];
    const [vehicles, users] = await Promise.all([
      prisma.vehicle.findMany({ where: { id: { in: vehicleIds } } }),
      editorIds.length ? prisma.user.findMany({ where: { id: { in: editorIds } } }) : Promise.resolve([] as User[]),
    ]);

    const generated = buildOutputFile(
      buildSnapshot({
        driver: d.driver, carrier, events, unidentifiedEvents: pool, vehicles, users, dailyLogs: logs, outputFileComment: d.comment,
        generatedAt: d.createdAt, eldIdentifier: carrier.eldIdentifier, eldRegistrationId: carrier.eldRegistrationId ?? '',
        // Same derivation as TransfersService.authenticationValue (private there).
        eldAuthenticationValue: createHash('sha256').update(`${carrier.eldIdentifier}:${carrier.eldRegistrationId ?? ''}:${d.driver.id}`).digest('hex').slice(0, 16).toUpperCase(),
      }),
    );
    const validation = validateOutputFile(generated.csv);
    if (!validation.valid) {
      inc('transferFileInvalid');
      if (!loggedInvalid) {
        ctx.log(`compliance: an eRODS file failed Appendix A validation and was skipped, as the API would: ${JSON.stringify(validation.issues.slice(0, 3))}`);
        loggedInvalid = true;
      }
      continue;
    }

    const sequence = (perDay.get(`${d.driver.id}|${endKey}`) ?? 0) + 1;
    perDay.set(`${d.driver.id}|${endKey}`, sequence);
    const fileName = buildOutputFileName({ lastName: d.driver.lastName, cdlNumber: d.driver.cdlNumber, sequence, dayCount: d.dayCount });
    const id = mockId('compliance-data-transfer', String(d.i));
    const body = Buffer.from(generated.csv, 'utf8');
    let fileKey = `${S3_MOCK_PREFIX}${id}.csv`;
    if (s3 && s3Ok) {
      try {
        fileKey = s3.withPrefix(fileKey);
        await s3.client.send(new PutObjectCommand({ Bucket: s3.bucket, Key: fileKey, Body: body, ContentType: 'text/csv', Metadata: { filename: fileName, filecheckvalue: generated.fileCheckValue, mock: 'true' } }));
        inc('transferFilesStored');
      } catch (err) {
        ctx.log(`compliance: MinIO put failed (${(err as Error).message}) — remaining transfers keep mock keys without objects`);
        s3Ok = false;
      }
    }
    const byDriver = d.byDriver || !d.driver.fleetManagerId;
    const requesterId = byDriver ? d.driver.id : (d.driver.fleetManagerId as string);
    const requesterType: EditorType = byDriver ? 'DRIVER' : 'USER';
    rows.push({
      id, driverId: d.driver.id, method: d.method, rangeStart: new Date(`${startKey}T00:00:00Z`), rangeEnd: new Date(`${endKey}T00:00:00Z`),
      outputFileComment: d.comment, fileName, fileKey, fileSizeBytes: body.length, checksum: createHash('sha256').update(body).digest('hex'),
      encrypted: d.outcome.encrypted, status: d.outcome.status, erodsMode: d.outcome.erodsMode, referenceId: d.outcome.referenceId,
      responseCode: d.outcome.responseCode, responseBody: d.outcome.responseBody, attempts: d.outcome.attempts, requestedById: requesterId,
      requestedByType: requesterType, createdAt: d.createdAt, sentAt: d.outcome.sentAt,
    });
    inc(`transfer_${d.method}_${d.outcome.status}`);
    audits.push({
      actorId: requesterId, actorType: requesterType, action: 'ERODS_TRANSFER_REQUESTED', objectType: 'DataTransfer', objectId: id,
      after: { driverId: d.driver.id, method: d.method, fileName, erodsMode: d.outcome.erodsMode, recipient: d.outcome.recipient, fileCheckValue: generated.fileCheckValue },
      detail: `${AUDIT_PREFIX}eRODS output file ${fileName} generated (${d.outcome.erodsMode} mode).`, createdAt: d.createdAt,
    });
    if (d.outcome.status !== 'QUEUED') {
      audits.push({
        actorId: requesterId, actorType: requesterType, action: d.outcome.status === 'TEST_ONLY' ? 'ERODS_TRANSFER_TEST_ONLY' : 'ERODS_TRANSFER_SEND',
        objectType: 'DataTransfer', objectId: id,
        after: { status: d.outcome.status, method: d.method, encrypted: d.outcome.encrypted, erodsMode: d.outcome.erodsMode, fileName },
        detail: `${AUDIT_PREFIX}eRODS ${d.method} transfer of ${fileName} finished with ${d.outcome.status}.`, createdAt: minDate(new Date(d.createdAt.getTime() + 45_000), now),
      });
    }
  }
  for (const part of chunks(rows, 5000)) await prisma.dataTransfer.createMany({ data: part });
  inc('transfers', rows.length);
  return audits;
}

function makeS3(): { client: S3Client; bucket: string; withPrefix: (k: string) => string } | null {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  if (!endpoint || !bucket) return null;
  const prefix = process.env.S3_KEY_PREFIX ?? '';
  const client = new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY ? { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY } : undefined,
  });
  return { client, bucket, withPrefix: (k: string) => (prefix ? `${prefix.replace(/\/$/, '')}/${k}` : k) };
}

async function clearMockObjects(client: S3Client, bucket: string, prefix: string): Promise<void> {
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key as string })).filter((o) => o.Key.startsWith(prefix));
    if (keys.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

/** B-059 — rebuilds every mock driver's `DailyLog` totals with the real header builder. */
async function rebuildDailyLogHeaders(ctx: MockContext, drivers: Driver[], now: Date): Promise<number> {
  const service = new HosRecalcService(new HosRecalcRepository(ctx.prisma as unknown as PrismaService));
  const fromKey = ANCHOR.toISOString().slice(0, 10);
  let rebuilt = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < drivers.length) {
      const driver = drivers[next];
      next += 1;
      rebuilt += await service.rebuildDailyLogs(driver.id, addDays(fromKey, -1), now);
    }
  };
  await Promise.all([worker(), worker()]);
  ctx.log(`compliance: rebuilt ${rebuilt} DailyLog headers for ${drivers.length} drivers`);
  return rebuilt;
}

async function enqueueRecalc(ctx: MockContext, recalcFrom: Map<string, string>): Promise<number> {
  if (!recalcFrom.size || process.env.MOCK_SKIP_RECALC === '1' || !process.env.REDIS_URL) return 0;
  const connection = new IORedis(process.env.REDIS_URL, { db: Number(process.env.REDIS_DB ?? 0), maxRetriesPerRequest: null, connectTimeout: 5000 });
  const queue = new Queue('hos-recalc', { connection, prefix: process.env.QUEUE_PREFIX });
  try {
    const jobs = [...recalcFrom.entries()].map(([driverId, fromDate]) => ({
      name: 'hos.recalc', data: { driverId, fromDate }, opts: { removeOnComplete: { count: 1000 }, removeOnFail: { count: 5000 } },
    }));
    await Promise.race([queue.addBulk(jobs), new Promise((_, reject) => setTimeout(() => reject(new Error('redis timeout')), 15_000))]);
    return jobs.length;
  } catch (err) {
    ctx.log(`compliance: could not enqueue hos.recalc (${(err as Error).message}) — HosViolation rows not refreshed`);
    return 0;
  } finally {
    await queue.close().catch(() => undefined);
    connection.disconnect();
  }
}

async function tableSizes(ctx: MockContext): Promise<Record<string, number>> {
  const rows = await ctx.prisma.$queryRawUnsafe<Array<{ name: string; bytes: bigint }>>(
    `SELECT 'EldEvent' AS name, COALESCE(SUM(pg_total_relation_size(inhrelid)), 0)::bigint AS bytes FROM pg_inherits WHERE inhparent = '"EldEvent"'::regclass
     UNION ALL SELECT 'AuditLog', pg_total_relation_size('"AuditLog"')
     UNION ALL SELECT 'UnidentifiedSegment', pg_total_relation_size('"UnidentifiedSegment"')
     UNION ALL SELECT 'DataTransfer', pg_total_relation_size('"DataTransfer"')
     UNION ALL SELECT 'DailyLog', pg_total_relation_size('"DailyLog"')`,
  );
  return Object.fromEntries(rows.map((r) => [r.name, Number(r.bytes)]));
}
