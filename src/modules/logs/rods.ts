/**
 * TZ §9 / §5.8 — the pure RODS day builder.
 *
 * Two §395 rules shape this file and neither is negotiable:
 *   1. The RODS day is split by `driver.homeTerminalTimezone` (§395.8(a), TZ §23) — never by
 *      `Carrier.timezone` and never by UTC. A DST day is therefore 23 or 25 hours long and the
 *      totals must add up to that, which is why every boundary comes from `hos/engine/timezone`.
 *   2. The graph is rebuilt from the ACTIVE §395 records only. `recordStatus = 2/3/4` records
 *      exist for the audit trail (§395.30) and never contribute duty time.
 *
 * Pure on purpose (no Prisma, no Nest): the same function serves the API, the eRODS file
 * generator (Phase 9) and the tests. PC/YM handling is delegated to `hos-event-mapper` so the
 * log grid and the HOS engine can never disagree about what counts as driving.
 */
import { buildSegments, normalizeEvents } from '../hos/engine/normalize';
import { dayEnd, dayKey, dayStart, dayLengthSec } from '../hos/engine/timezone';
import { mapEldEventsToNormalized } from '../hos/hos-event-mapper';
import type { DutyStatus, SpecialDrivingCategory } from '../hos/hos.types';

/** The subset of `EldEvent` the RODS day is rebuilt from. */
export interface RodsEvent {
  id?: bigint;
  eventType: number;
  eventCode: number;
  eventDateTime: Date;
  recordStatus: number;
  recordOrigin: number;
  eventSequenceId: number;
  supersedesId?: bigint | null;
  totalVehicleMiles?: number | null;
  annotation?: string | null;
  locationName?: string | null;
}

export interface RodsSegment {
  /** The recorded duty status (PC still reads as OFF's parent status here). */
  status: DutyStatus;
  /** What the segment COUNTS as: PC ⇒ OFF, YM ⇒ ON (§395.1(e)(1)/(2), TZ §8.2 rules 10/11). */
  effective: DutyStatus;
  special: SpecialDrivingCategory;
  startAt: Date;
  endAt: Date;
  durationSec: number;
}

export interface RodsDay {
  logDate: string;
  timezone: string;
  startAt: Date;
  endAt: Date;
  /** 23 h / 24 h / 25 h in seconds — the DST-correct length of this RODS day (§23). */
  dayLengthSec: number;
  segments: RodsSegment[];
  offDutySec: number;
  sleeperSec: number;
  drivingSec: number;
  onDutySec: number;
  /** Seconds actually accounted for — equals `dayLengthSec` for any day already finished. */
  accountedSec: number;
  totalDistanceMi: number;
  /** True when any record of this day was driver- or carrier-edited (§9.1/§9.3). */
  hasEdits: boolean;
}

/** §5.5 — ids whose record was marked "Inactive — Changed" by a later append-only record. */
export function supersededEventIds(events: RodsEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.recordStatus === 2 && event.supersedesId !== null && event.supersedesId !== undefined) {
      ids.add(String(event.supersedesId));
    }
  }
  return ids;
}

/**
 * The records that describe the driver's real duty timeline: `recordStatus = 1` minus the ones
 * a later "Inactive — Changed" record retired. `EldEvent` is append-only at the DB level
 * (§5.5, REVOKE UPDATE), so a retired record keeps `recordStatus = 1` on its own row and is
 * identified only through the marker that points at it — see decisions.md D-019.
 */
export function activeRecords(events: RodsEvent[]): RodsEvent[] {
  const retired = supersededEventIds(events);
  return events.filter(
    (event) => event.recordStatus === 1 && !(event.id !== undefined && retired.has(String(event.id))),
  );
}

/** Statuses a §395 duty-status record can carry, by `eventCode`. */
export const DUTY_STATUS_BY_CODE: Record<number, DutyStatus> = { 1: 'OFF', 2: 'SB', 3: 'D', 4: 'ON' };
export const DUTY_CODE_BY_STATUS: Record<DutyStatus, number> = { OFF: 1, SB: 2, D: 3, ON: 4 };

/**
 * Rebuilds one RODS day. `events` must cover the day AND enough history before it for the
 * status in force at midnight to be known (the caller passes a lookback window).
 */
export function buildRodsDay(
  events: RodsEvent[],
  timezone: string,
  logDate: string,
  now: Date = new Date(),
): RodsDay {
  const startAt = dayStart(timezone, logDate);
  const endOfDay = dayEnd(timezone, logDate);
  const bound = now.getTime() < endOfDay.getTime() ? now : endOfDay;

  const active = activeRecords(events);
  const normalized = normalizeEvents(mapEldEventsToNormalized(active), bound);
  const raw = buildSegments(normalized, bound);

  const segments: RodsSegment[] = [];
  for (const segment of raw) {
    const from = segment.start.getTime() < startAt.getTime() ? startAt : segment.start;
    const to = segment.end.getTime() > bound.getTime() ? bound : segment.end;
    const durationSec = Math.round((to.getTime() - from.getTime()) / 1000);
    if (durationSec <= 0) continue;
    segments.push({
      status: segment.status,
      effective: segment.effective,
      special: segment.special,
      startAt: from,
      endAt: to,
      durationSec,
    });
  }

  // §395.8(a) — a day with no record at all is a full off-duty day, not an empty grid.
  const coveredSec = segments.reduce((sum, s) => sum + s.durationSec, 0);
  const spanSec = Math.max(0, Math.round((bound.getTime() - startAt.getTime()) / 1000));
  const leadingGapSec = segments.length
    ? Math.max(0, Math.round((segments[0].startAt.getTime() - startAt.getTime()) / 1000))
    : spanSec;

  const totals = { OFF: leadingGapSec, SB: 0, D: 0, ON: 0 } as Record<DutyStatus, number>;
  for (const segment of segments) totals[segment.effective] += segment.durationSec;

  const inDay = active.filter(
    (event) =>
      event.eventDateTime.getTime() >= startAt.getTime() &&
      event.eventDateTime.getTime() < endOfDay.getTime(),
  );
  const miles = inDay
    .map((event) => event.totalVehicleMiles)
    .filter((value): value is number => typeof value === 'number');

  const editedInDay = events.filter(
    (event) =>
      event.eventDateTime.getTime() >= startAt.getTime() &&
      event.eventDateTime.getTime() < endOfDay.getTime() &&
      (event.recordOrigin === 2 || event.recordOrigin === 3 || event.recordStatus !== 1),
  );

  return {
    logDate,
    timezone,
    startAt,
    endAt: endOfDay,
    dayLengthSec: dayLengthSec(timezone, logDate),
    segments,
    offDutySec: totals.OFF,
    sleeperSec: totals.SB,
    drivingSec: totals.D,
    onDutySec: totals.ON,
    accountedSec: coveredSec + leadingGapSec,
    totalDistanceMi: miles.length ? Math.max(0, Math.max(...miles) - Math.min(...miles)) : 0,
    hasEdits: editedInDay.length > 0,
  };
}

/** The RODS day a given instant belongs to, in the driver's home-terminal zone (§23). */
export function rodsDayOf(timezone: string, at: Date): string {
  return dayKey(timezone, at);
}

/**
 * The duty status in force immediately BEFORE `at`, from the active timeline. Used to build
 * the "neutralizing" record an append-only edit needs (D-019) and to restore the status that
 * follows an inserted interval (§9.3).
 */
export function statusInEffectAt(events: RodsEvent[], at: Date): DutyStatus | null {
  const normalized = normalizeEvents(mapEldEventsToNormalized(activeRecords(events)), at);
  const before = normalized.filter((event) => event.at.getTime() < at.getTime());
  if (!before.length) return null;
  const last = before[before.length - 1];
  return last.status;
}

/** Active DRIVING intervals (§395.30 — the time no edit may ever touch). */
export function drivingIntervals(events: RodsEvent[], now: Date = new Date()): Array<{ startAt: Date; endAt: Date }> {
  const normalized = normalizeEvents(mapEldEventsToNormalized(activeRecords(events)), now);
  return buildSegments(normalized, now)
    .filter((segment) => segment.effective === 'D')
    .map((segment) => ({ startAt: segment.start, endAt: segment.end }));
}
