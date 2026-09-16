/**
 * OneBook ELD — pure planning logic of the `compliance` mock generator.
 *
 * Everything here is deterministic and DB-free so it can be unit-tested. The rules are the
 * production ones, imported from `src/modules/logs` / `src/modules/transfers` — never
 * re-implemented: a mock edit that the real API would refuse with `422 DRIVING_TIME_IMMUTABLE`
 * is never generated (49 CFR §395.30(c)(2)).
 */
import { createHash } from 'node:crypto';
import { createRng, MockRng } from '../context';
import type { DutyStatus } from '../../../src/modules/hos/hos.types';
import { certificationEventCode } from '../../../src/modules/logs/certification';
import { checkEditProposal, isDrivingRecord, type Interval } from '../../../src/modules/logs/edit-rules';
import { activeRecords, drivingIntervals, DUTY_STATUS_BY_CODE, type RodsEvent } from '../../../src/modules/logs/rods';
import { isFmcsaRecipient } from '../../../src/modules/transfers/fmcsa-recipient';
import { valueAt, type TimelinePoint } from './ingest.helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------------------------
// identity + randomness
// ---------------------------------------------------------------------------------------------

const UUID_NAMESPACE = 'onebook-mock-compliance-v1';

/**
 * Fixed tail on every uuid this generator appends, so a re-run can tell its own records apart
 * from the `hos`/`ingest` ones and plan from the same base timeline (98 bits stay random).
 */
export const MOCK_UUID_SUFFIX = 'c0c0c0';

/**
 * Deterministic RFC 4122 v5-shaped uuid. `EldEvent` and `AuditLog` are append-only (UPDATE and
 * DELETE revoked for `eld_dev`), so idempotency cannot be "delete then insert": every appended
 * record gets a uuid derived from what it represents and a re-run skips uuids that exist.
 */
export function mockUuid(key: string): string {
  const h = createHash('sha1').update(`${UUID_NAMESPACE}:${key}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex').slice(0, 26) + MOCK_UUID_SUFFIX;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function isComplianceUuid(uuid: string): boolean {
  return uuid.endsWith(MOCK_UUID_SUFFIX);
}

/** FNV-1a 32-bit — a stable per-entity seed, so an entity's plan never depends on run order. */
export function seedOf(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rngFor(key: string): MockRng {
  return createRng(seedOf(`compliance:${key}`));
}

// ---------------------------------------------------------------------------------------------
// text pools (every entry is 4..60 chars — §9.3 / Appendix A)
// ---------------------------------------------------------------------------------------------

export const CARRIER_REASONS = {
  RESTATUS: [
    'Fuel receipt shows driver was on duty',
    'Shipper detention - driver was on duty',
    'Driver was in sleeper berth, not off duty',
    'Team trip sheet shows sleeper berth',
    'Lumper receipt shows loading time',
    'Driver was on meal break per dispatch notes',
  ],
  SHIFT: [
    'Gate log shows arrival later than logged',
    'Pre-trip started later per DVIR timestamp',
    'Scale ticket time corrects on-duty start',
    'Terminal badge scan shows clock-in time',
  ],
  INSERT: [
    'Missing pre-trip inspection time',
    'Fueling stop was not logged on duty',
    'Load securement check not recorded',
    'Missing post-trip inspection time',
  ],
  EXTEND_DRIVING: [
    'ECM shows vehicle moving before status change',
    'GPS trail shows departure before log entry',
    'Telematics: driving began before recorded time',
  ],
  ANNOTATE_DRIVING: [
    'Detour due to interstate closure',
    'Adverse weather - slowed by snow and ice',
    'Road construction delay per DOT notice',
  ],
} as const;

export const DRIVER_REJECT_NOTES = [
  'Log is correct as recorded',
  'I was off duty at that time',
  'Receipt time is from the store clock',
  'Disagree - talked to dispatch already',
];

export const DRIVER_ACCEPT_NOTES = ['Agreed, thanks', 'Correct, forgot to switch', 'OK - matches my receipt'];

export const UNIDENTIFIED_NOTES = {
  ANNOTATED: [
    'Yard move by shop mechanic - no driver',
    'Moved by tow and repair vendor',
    'Trailer shuffle at terminal by yard jockey',
    'Test drive after PM service',
    'Wash bay move by fuel island attendant',
  ],
  REJECTED_POOL: [
    'Not a driver move - reviewed with telematics',
    'Unit was in shop, tech moved it',
    'No driver on duty matches this segment',
  ],
  DRIVER_CLAIM: ['That was me, forgot to log in', 'Moved truck before logging in', 'My move - app was not connected'],
  DRIVER_DECLINE: ['Not me - I was off duty at home', 'I was not on this unit that day', 'Not my driving, I was at the terminal'],
} as const;

// ---------------------------------------------------------------------------------------------
// timeline helpers
// ---------------------------------------------------------------------------------------------

export interface Timeline {
  events: RodsEvent[];
  /** Active duty-status records (eventType 1), chronological. */
  duty: RodsEvent[];
  driving: Interval[];
}

export function buildTimeline(events: RodsEvent[], now: Date): Timeline {
  const duty = activeRecords(events)
    .filter((row) => row.eventType === 1)
    .sort((a, b) => a.eventDateTime.getTime() - b.eventDateTime.getTime() || a.eventSequenceId - b.eventSequenceId);
  return { events, duty, driving: drivingIntervals(events, now) };
}

function indexOf(timeline: Timeline, target: RodsEvent): number {
  return timeline.duty.findIndex((row) => row === target || (row.id !== undefined && row.id === target.id));
}

/** End of the interval a record owns: the next active duty record, or `now` (logs.service). */
export function intervalEndOf(timeline: Timeline, target: RodsEvent, now: Date): Date {
  const i = indexOf(timeline, target);
  const next = i >= 0 ? timeline.duty.slice(i + 1).find((row) => row.eventDateTime > target.eventDateTime) : undefined;
  return next ? next.eventDateTime : now;
}

function previousOf(timeline: Timeline, target: RodsEvent): RodsEvent | undefined {
  const i = indexOf(timeline, target);
  for (let j = i - 1; j >= 0; j -= 1) {
    if (timeline.duty[j].eventDateTime < target.eventDateTime) return timeline.duty[j];
  }
  return undefined;
}

function statusOf(row: RodsEvent): DutyStatus | undefined {
  return DUTY_STATUS_BY_CODE[row.eventCode];
}

export function drivingSeconds(events: RodsEvent[], now: Date): number {
  return drivingIntervals(events, now).reduce((acc, i) => acc + (i.endAt.getTime() - i.startAt.getTime()) / 1000, 0);
}

export function overlapsAny(startAt: Date, endAt: Date, intervals: Interval[]): boolean {
  return intervals.some((i) => i.startAt.getTime() < endAt.getTime() && startAt.getTime() < i.endAt.getTime());
}

// ---------------------------------------------------------------------------------------------
// Vehicle odometer / engine hours for records appended between hos records (B-060)
// ---------------------------------------------------------------------------------------------

/** The hos generator's odometer/engine-hour readings on one truck, sorted by instant. */
export interface VehicleTimeline {
  mi: TimelinePoint[];
  eh: TimelinePoint[];
}

export interface OdometerReading {
  totalVehicleMiles: number | null;
  totalEngineHours: number | null;
}

/**
 * Builds a truck's timeline from its hos records (any order). Readings are made monotone by
 * running maximum, so a later interpolation can never return a value below an earlier record.
 */
export function buildVehicleTimeline(rows: Array<{ at: Date; miles: number | null; engineHours: number | null }>): VehicleTimeline {
  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
  const mi: TimelinePoint[] = [];
  const eh: TimelinePoint[] = [];
  let maxMi = -Infinity;
  let maxEh = -Infinity;
  for (const r of sorted) {
    if (r.miles !== null && Number.isFinite(r.miles)) {
      maxMi = Math.max(maxMi, r.miles);
      mi.push({ at: r.at.getTime(), value: maxMi });
    }
    if (r.engineHours !== null && Number.isFinite(r.engineHours)) {
      maxEh = Math.max(maxEh, r.engineHours);
      eh.push({ at: r.at.getTime(), value: maxEh });
    }
  }
  return { mi, eh };
}

/**
 * Odometer and engine hours for a record at `at`, interpolated between the surrounding hos
 * records of the same truck and clamped to them (before the first / after the last record the
 * nearest reading is used). A truck with no hos record at all yields nulls — never a value
 * derived from `Vehicle.odometerMi`, whose base is unrelated to the hos history (B-060).
 * `floor` is a lower bound (the segment's own earlier record) so a segment's records never step
 * back among themselves either.
 */
export function readingAt(tl: VehicleTimeline, at: Date, floor: OdometerReading | null = null): OdometerReading {
  const t = at.getTime();
  const miles = valueAt(tl.mi, t, 0);
  // `valueAt` floors to 2 digits in binary; re-express the result as the Decimal(10,2) the column
  // stores, so the value compared later is exactly the one written.
  const raw = valueAt(tl.eh, t, 2);
  const hours = raw === null ? null : Number(raw.toFixed(2));
  return {
    totalVehicleMiles: miles === null ? null : Math.max(miles, floor?.totalVehicleMiles ?? -Infinity),
    totalEngineHours: hours === null ? null : Math.max(hours, floor?.totalEngineHours ?? -Infinity),
  };
}

// ---------------------------------------------------------------------------------------------
// §395.30 carrier edit proposals
// ---------------------------------------------------------------------------------------------

export type CarrierEditKind = keyof typeof CARRIER_REASONS;

export interface CarrierProposal {
  kind: CarrierEditKind;
  status: DutyStatus;
  startAt: Date;
  endAt: Date | null;
  reason: string;
  intervalEndAt: Date;
}

/**
 * Picks a realistic proposal for `target` and returns it only if `checkEditProposal` (the exact
 * rule the API enforces) accepts it. Driving records may only be extended or annotated.
 */
export function proposeCarrierEdit(timeline: Timeline, target: RodsEvent, rng: MockRng, now: Date): CarrierProposal | null {
  const status = statusOf(target);
  if (!status) return null;
  const start = target.eventDateTime.getTime();
  const intervalEndAt = intervalEndOf(timeline, target, now);
  const intervalMs = intervalEndAt.getTime() - start;
  const prev = previousOf(timeline, target);
  // Draws are unconditional so every branch consumes the same stream.
  const roll = rng.next();
  const shortShift = rng.int(3, 15) * MIN;
  const shift = rng.int(10, 30) * MIN;
  const restatusPick = rng.next();
  const offsetRoll = rng.next();
  const dur = rng.int(15, 45) * MIN;
  let proposal: Omit<CarrierProposal, 'reason' | 'intervalEndAt'> | null = null;

  if (isDrivingRecord(target)) {
    const prevStatus = prev ? statusOf(prev) : undefined;
    const gapMs = prev ? start - prev.eventDateTime.getTime() : 0;
    if (prev && prevStatus && prevStatus !== 'D' && gapMs > shortShift + 5 * MIN && roll < 0.55) {
      proposal = { kind: 'EXTEND_DRIVING', status: 'D', startAt: new Date(start - shortShift), endAt: null };
    } else {
      proposal = { kind: 'ANNOTATE_DRIVING', status: 'D', startAt: target.eventDateTime, endAt: null };
    }
  } else if (roll < 0.4) {
    const options: Record<Exclude<DutyStatus, 'D'>, DutyStatus[]> = { OFF: ['ON', 'SB'], ON: ['OFF'], SB: ['OFF'] };
    const list = options[status as Exclude<DutyStatus, 'D'>];
    proposal = { kind: 'RESTATUS', status: list[Math.floor(restatusPick * list.length)], startAt: target.eventDateTime, endAt: null };
  } else if (roll < 0.7) {
    // Moving a record LATER back-fills the gap with the previous status; never after driving,
    // or the "correction" would silently create driving time.
    if (intervalMs > shift + 15 * MIN && prev && statusOf(prev) !== 'D') {
      proposal = { kind: 'SHIFT', status, startAt: new Date(start + shift), endAt: null };
    }
  } else if ((status === 'OFF' || status === 'SB') && intervalMs >= 90 * MIN) {
    const offset = (15 + Math.floor(offsetRoll * Math.max(1, Math.floor(intervalMs / MIN) - 75))) * MIN;
    proposal = { kind: 'INSERT', status: 'ON', startAt: new Date(start + offset), endAt: new Date(start + offset + dur) };
  }
  if (!proposal) return null;
  if (proposal.endAt && proposal.endAt.getTime() >= intervalEndAt.getTime()) return null;
  if (proposal.startAt.getTime() > now.getTime()) return null;

  const verdict = checkEditProposal(
    { eventType: target.eventType, eventCode: target.eventCode, eventDateTime: target.eventDateTime, intervalEndAt },
    { proposedStatus: proposal.status, proposedStart: proposal.startAt, proposedEnd: proposal.endAt },
    timeline.driving,
  );
  if (verdict) return null;
  return { ...proposal, reason: rng.pick(CARRIER_REASONS[proposal.kind]), intervalEndAt };
}

// ---------------------------------------------------------------------------------------------
// outcomes
// ---------------------------------------------------------------------------------------------

export type EditOutcome = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export function decideEditOutcome(rng: MockRng, requestedAt: Date, now: Date): { outcome: EditOutcome; resolvedAt: Date | null } {
  const ageDays = (now.getTime() - requestedAt.getTime()) / DAY;
  const roll = rng.next();
  const resolvedAt = new Date(requestedAt.getTime() + rng.int(10, 48 * 60) * MIN);
  const [pPending, pAccept] = ageDays < 7 ? [0.6, 0.85] : [0.08, 0.7];
  if (roll < pPending || resolvedAt.getTime() > now.getTime()) return { outcome: 'PENDING', resolvedAt: null };
  return { outcome: roll < pAccept ? 'ACCEPTED' : 'REJECTED', resolvedAt };
}

export interface CertAction {
  at: Date;
  /** Appendix A event code: 1 first, 2..9 re-certification, saturating at 9. */
  eventCode: number;
  onBehalf: boolean;
}

export interface CertReplay {
  /** Certifications this generator appends (the base ones already exist). */
  added: CertAction[];
  certified: boolean;
  certifiedAt: Date | null;
  certificationCount: number;
}

/**
 * §9.2 / §395.22(i) — replays a RODS day's certification state over the changes this generator
 * applied. `baseCerts` are the certifications already recorded (hos). A change after the latest
 * certification invalidates it; the driver usually re-certifies within ~30 hours.
 */
export function replayCertification(rng: MockRng, baseCerts: Date[], changes: Date[], now: Date, pOnBehalf = 0.08): CertReplay {
  const base = [...baseCerts].sort((a, b) => a.getTime() - b.getTime());
  let count = base.length;
  let lastCert: Date | null = base.length ? base[base.length - 1] : null;
  let certified = base.length > 0;
  let pending: { at: Date; onBehalf: boolean } | null = null;
  const added: CertAction[] = [];
  const commit = (): void => {
    if (!pending) return;
    added.push({ at: pending.at, eventCode: certificationEventCode(count), onBehalf: pending.onBehalf });
    count += 1;
    lastCert = pending.at;
    certified = true;
    pending = null;
  };

  for (const change of [...changes].sort((a, b) => a.getTime() - b.getTime())) {
    const recertRoll = rng.next();
    const delay = rng.int(60, 30 * 60) * MIN;
    const onBehalf = rng.chance(pOnBehalf);
    if (change.getTime() > now.getTime()) continue;
    if (pending && pending.at.getTime() <= change.getTime()) commit();
    if (certified && lastCert && lastCert.getTime() < change.getTime()) {
      certified = false;
      pending = recertRoll < 0.8 ? { at: new Date(change.getTime() + delay), onBehalf } : null;
    }
  }
  if (pending && (pending as { at: Date }).at.getTime() <= now.getTime()) commit();

  return { added, certified, certifiedAt: certified ? lastCert : null, certificationCount: count };
}

export type SegmentStatus = 'PENDING' | 'ASSIGNED' | 'ANNOTATED' | 'REJECTED';

/** Status of a vehicle-pool segment. `assignable` = a driver could plausibly have made it. */
export function decideSegmentStatus(
  rng: MockRng,
  endAt: Date,
  now: Date,
  assignable: boolean,
): { status: SegmentStatus; actedAt: Date | null } {
  const recent = now.getTime() - endAt.getTime() < 14 * DAY;
  // Draws are unconditional so the stream stays aligned when `now` flips an outcome.
  const roll = rng.next();
  const delayMin = rng.int(60, 6 * 24 * 60);
  const table: Array<[SegmentStatus, number]> = recent
    ? [['PENDING', 0.65], ['ANNOTATED', 0.8], ['ASSIGNED', 0.9], ['REJECTED', 1]]
    : [['PENDING', 0.1], ['ANNOTATED', 0.45], ['ASSIGNED', 0.75], ['REJECTED', 1]];
  let status = (table.find(([, p]) => roll < p) ?? table[table.length - 1])[0];
  if (status === 'ASSIGNED' && !assignable) status = 'ANNOTATED';
  if (status === 'PENDING') return { status, actedAt: null };
  const actedAt = new Date(endAt.getTime() + delayMin * MIN);
  return actedAt.getTime() > now.getTime() ? { status: 'PENDING', actedAt: null } : { status, actedAt };
}

export interface PoolEventLike {
  id: bigint;
  eventType: number;
  eventCode: number;
  eventDateTime: Date;
}

export interface PoolEpisode<T extends PoolEventLike> {
  startAt: Date;
  endAt: Date;
  events: T[];
}

/**
 * §7.4 rule 3 — one segment per contiguous run of unidentified records on a vehicle: a DRIVING
 * record through the next ON-DUTY record, plus the engine power-up/down and intermediate records
 * that bracket it (within 5 minutes).
 */
export function groupPoolEpisodes<T extends PoolEventLike>(events: T[]): Array<PoolEpisode<T>> {
  const sorted = [...events].sort((a, b) => a.eventDateTime.getTime() - b.eventDateTime.getTime());
  const out: Array<PoolEpisode<T>> = [];
  let i = 0;
  while (i < sorted.length) {
    if (!(sorted[i].eventType === 1 && sorted[i].eventCode === 3)) {
      i += 1;
      continue;
    }
    const startAt = sorted[i].eventDateTime;
    let j = i + 1;
    while (j < sorted.length && !(sorted[j].eventType === 1 && sorted[j].eventCode !== 3)) j += 1;
    if (j >= sorted.length) break;
    const endAt = sorted[j].eventDateTime;
    const lo = startAt.getTime() - 5 * MIN;
    const hi = endAt.getTime() + 5 * MIN;
    const members = sorted.filter(
      (e) => e.eventDateTime.getTime() >= lo && e.eventDateTime.getTime() <= hi && (e.eventType === 1 || e.eventType === 2 || e.eventType === 6),
    );
    out.push({ startAt, endAt, events: members });
    i = j + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// eRODS transfers
// ---------------------------------------------------------------------------------------------

export const FMCSA_RECIPIENTS = ['eld-transfer@eld.fmcsa.dot.gov', 'roadside@mcsap.fmcsa.dot.gov', 'erods@fmcsa.dot.gov'];

const STATES = ['TX', 'OH', 'IN', 'GA', 'CA', 'AZ', 'CO', 'IL', 'TN', 'PA', 'NM', 'OK'];

/** Appendix A "output file comment" — the routing code a safety official reads out. ≤ 60 chars. */
export function routingComment(rng: MockRng): string {
  const st = rng.pick(STATES);
  const n = String(rng.int(0, 999_999)).padStart(6, '0');
  const badge = rng.int(1000, 99999);
  const route = rng.pick([10, 20, 35, 40, 70, 75, 80]);
  const templates = [
    `${st}${n}`,
    `Routing code ${st}-${n}`,
    `${st} DPS roadside inspection ${n}`,
    `MCSAP officer badge ${badge} ${st}`,
    `Weigh station ${st} I-${route} report ${n}`,
  ];
  return rng.pick(templates).slice(0, 60);
}

export type TransferMethodName = 'WEB_SERVICES' | 'EMAIL';
export type TransferStatusName = 'QUEUED' | 'TEST_ONLY' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'FAILED';

export interface TransferOutcome {
  status: TransferStatusName;
  erodsMode: 'TEST' | 'PRODUCTION';
  encrypted: boolean;
  referenceId: string | null;
  responseCode: string | null;
  responseBody: string | null;
  attempts: number;
  sentAt: Date | null;
  recipient: string | null;
}

/**
 * Mirrors `FmcsaTransferService` + `transfer.processor`: TEST → `TEST_ONLY` (nothing sent);
 * EMAIL is always encrypted and only to `*.fmcsa.dot.gov`; web services rely on TLS only.
 */
export function decideTransferOutcome(rng: MockRng, method: TransferMethodName, createdAt: Date, now: Date): TransferOutcome {
  const picked = rng.pick(FMCSA_RECIPIENTS);
  const recipient = method === 'EMAIL' ? picked : null;
  const sentAt = new Date(Math.min(now.getTime(), createdAt.getTime() + rng.int(3, 90) * 1000));
  const roll = rng.next();
  const refNo = rng.int(0, 99_999_999);
  if (now.getTime() - createdAt.getTime() < 20 * MIN) {
    // The recipient is parked on `responseBody` until the worker sends (transfers.service).
    return { status: 'QUEUED', erodsMode: 'PRODUCTION', encrypted: false, referenceId: null, responseCode: null, responseBody: recipient, attempts: 0, sentAt: null, recipient };
  }
  const keyFp = 'SHA256:mock-fmcsa-key';
  const ref = `FMCSA-${createdAt.toISOString().slice(0, 10).replace(/-/g, '')}-${String(refNo).padStart(8, '0')}`;
  const base = { erodsMode: 'PRODUCTION' as const, recipient };
  if (roll < 0.3) {
    return {
      ...base, status: 'TEST_ONLY', erodsMode: 'TEST', encrypted: method === 'EMAIL', referenceId: null, responseCode: 'TEST_ONLY',
      responseBody: 'erodsMode=TEST — file not transmitted to FMCSA (tz.md §10.1).', attempts: 1, sentAt: null,
    };
  }
  if (method === 'EMAIL') {
    return roll < 0.8
      ? { ...base, status: 'SENT', encrypted: true, referenceId: `<${ref.toLowerCase()}@mail.mock>`, responseCode: 'SENT', responseBody: `openpgp key=${keyFp}`, attempts: 1, sentAt }
      : { ...base, status: 'FAILED', encrypted: true, referenceId: null, responseCode: 'SMTP_421', responseBody: `openpgp key=${keyFp}`, attempts: 3, sentAt: null };
  }
  if (roll < 0.65) return { ...base, status: 'ACCEPTED', encrypted: false, referenceId: ref, responseCode: '200', responseBody: '{"status":"accepted","errors":[]}', attempts: 1, sentAt };
  if (roll < 0.8) return { ...base, status: 'SENT', encrypted: false, referenceId: ref, responseCode: '202', responseBody: '{"status":"received"}', attempts: 1, sentAt };
  if (roll < 0.9) {
    return { ...base, status: 'REJECTED', encrypted: false, referenceId: ref, responseCode: '422', responseBody: '{"status":"rejected","errors":["File data check value mismatch"]}', attempts: 1, sentAt };
  }
  return { ...base, status: 'FAILED', encrypted: false, referenceId: null, responseCode: '503', responseBody: 'FMCSA eRODS web service unavailable (timeout after 30s)', attempts: 3, sentAt: null };
}

export { isFmcsaRecipient };
