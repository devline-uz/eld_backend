/**
 * TZ §5.8 / §9 — the ONE place a `DailyLog` header (the per-RODS-day totals) is derived.
 *
 * bugs.md B-059: the header used to be written only by the `GET /logs` read path, so every
 * writer that appends §395 records (edit acceptance, driver self-edits, unidentified
 * assignment, ingest) left it stale — and `hos.recalc` reads those stale totals as the 70/8
 * recap (`previousDays`). Every writer now rebuilds through this function, so the log view,
 * the recalculation and the mock generators can never disagree about a day's totals.
 *
 * Pure on purpose (no Prisma, no Nest): it only wraps `buildRodsDay` with the day windowing
 * and the two header flags that are not a function of the events alone.
 */
import { addDays, dayEnd, dayKey, dayStart } from '../hos/engine/timezone';
import { buildRodsDay, type RodsDay, type RodsEvent } from './rods';

/**
 * History before a day that is fed to its rebuild, so a status in force for several days
 * (a long sleeper or on-duty carry-over across midnight) is counted as that status and not as
 * a leading off-duty gap. Matches the HOS recalculation lookback (`RECALC_LOOKBACK_DAYS`).
 */
export const RODS_HEADER_LOOKBACK_DAYS = 9;

/** Hard cap on the days one rebuild may walk (§19 — bounded work per call). */
export const RODS_HEADER_MAX_DAYS = 400;

/** The `UnidentifiedSegment` columns the `hasUnassigned` flag needs. */
export interface HeaderUnidentifiedSegment {
  status: string;
  startAt: Date;
  endAt: Date;
}

/** Everything a `DailyLog` upsert writes. Certification columns are deliberately absent (§9.2). */
export interface DailyLogHeaderTotals {
  logDate: string;
  timezone: string;
  offDutySec: number;
  sleeperSec: number;
  drivingSec: number;
  onDutySec: number;
  totalDistanceMi: number;
  hasUnassigned: boolean;
  hasEdits: boolean;
}

export interface BuiltDailyLogHeader {
  day: RodsDay;
  header: DailyLogHeaderTotals;
}

export interface BuildDailyLogHeadersInput {
  /** Every record of the driver in `[dayStart(fromKey - lookback), dayEnd(toKey))`, ANY status. */
  events: RodsEvent[];
  timezone: string;
  fromKey: string;
  toKey: string;
  now: Date;
  /**
   * Segments on the driver's units touching the range; only unresolved ones (`PENDING`, and
   * B-83 `PENDING_CONFIRMATION` — still unattributed) raise the flag.
   */
  segments: HeaderUnidentifiedSegment[];
  /** Stored `hasEdits` per "YYYY-MM-DD": once a day was edited it stays edited (§9.2). */
  previousHasEdits?: ReadonlyMap<string, boolean>;
  maxDays?: number;
}

/** Every RODS day key from `from` to `to`, inclusive, capped at `max` days. */
export function rodsDayKeys(from: string, to: string, max: number = RODS_HEADER_MAX_DAYS): string[] {
  const keys: string[] = [];
  let key = from;
  for (let guard = 0; guard < max; guard += 1) {
    keys.push(key);
    if (key >= to) break;
    key = addDays(key, 1);
  }
  return keys;
}

/**
 * The RODS days whose header an event change in `[from, to]` can alter: the day of `from`
 * through the day AFTER `to` (a status carried over midnight), never past today. A change at
 * instant t only affects time >= t, so no earlier day is ever included. `null` when the span
 * lies entirely in the future.
 */
export function affectedHeaderRange(
  timezone: string,
  from: Date,
  to: Date,
  now: Date,
): { fromKey: string; toKey: string } | null {
  const todayKey = dayKey(timezone, now);
  const fromKey = dayKey(timezone, from.getTime() <= to.getTime() ? from : to);
  const lastKey = dayKey(timezone, from.getTime() <= to.getTime() ? to : from);
  if (fromKey > todayKey) return null;
  const next = addDays(lastKey, 1);
  return { fromKey, toKey: next > todayKey ? todayKey : next };
}

/** Rebuilds the header of every RODS day in `[fromKey, toKey]` from the stored records. */
export function buildDailyLogHeaders(input: BuildDailyLogHeadersInput): BuiltDailyLogHeader[] {
  const { timezone, now } = input;
  const events = [...input.events].sort(
    (a, b) => a.eventDateTime.getTime() - b.eventDateTime.getTime() || a.eventSequenceId - b.eventSequenceId,
  );
  const pending = input.segments.filter(
    (segment) => segment.status === 'PENDING' || segment.status === 'PENDING_CONFIRMATION',
  );
  const out: BuiltDailyLogHeader[] = [];

  let lo = 0;
  let hi = 0;
  for (const key of rodsDayKeys(input.fromKey, input.toKey, input.maxDays)) {
    const windowFrom = dayStart(timezone, addDays(key, -RODS_HEADER_LOOKBACK_DAYS)).getTime();
    const windowTo = dayEnd(timezone, key).getTime();
    while (lo < events.length && events[lo].eventDateTime.getTime() < windowFrom) lo += 1;
    if (hi < lo) hi = lo;
    while (hi < events.length && events[hi].eventDateTime.getTime() < windowTo) hi += 1;

    const day = buildRodsDay(events.slice(lo, hi), timezone, key, now);
    const hasUnassigned = pending.some(
      (segment) =>
        segment.startAt.getTime() < day.endAt.getTime() && segment.endAt.getTime() > day.startAt.getTime(),
    );
    out.push({
      day,
      header: {
        logDate: key,
        timezone,
        offDutySec: day.offDutySec,
        sleeperSec: day.sleeperSec,
        drivingSec: day.drivingSec,
        onDutySec: day.onDutySec,
        totalDistanceMi: day.totalDistanceMi,
        hasUnassigned,
        hasEdits: day.hasEdits || input.previousHasEdits?.get(key) === true,
      },
    });
  }
  return out;
}
