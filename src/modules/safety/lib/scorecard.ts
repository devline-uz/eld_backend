import { addDays, dayEnd, dayKey, dayStart } from '../../hos/engine/timezone';

/**
 * D-133 — W-10 scorecard period, ranking and fleet-score helpers. Pure: no I/O, no clock reads
 * (the caller passes `now`), so the nightly job and its tests agree on every boundary.
 */

/** Rolling scorecard period length, in home-terminal calendar days (inclusive). */
export const SCORE_PERIOD_DAYS = 30;
/** Scores below this are flagged "needs attention" (eld.docs/web §9). */
export const SCORE_ATTENTION_THRESHOLD = 70;

export interface ScorePeriod {
  /** First day, "YYYY-MM-DD" (inclusive). */
  startKey: string;
  /** Last day, "YYYY-MM-DD" (inclusive). */
  endKey: string;
}

/**
 * The newest calendar day that has fully ended in EVERY given home-terminal zone at `now` — the
 * end of the period the nightly run scores. Using the minimum keeps one shared period label for
 * the whole fleet without ever scoring a day that is still in progress somewhere.
 */
export function latestCompleteDay(now: Date, timeZones: readonly string[]): string {
  const zones = timeZones.length > 0 ? timeZones : ['UTC'];
  return zones.map((tz) => addDays(dayKey(tz, now), -1)).reduce((min, key) => (key < min ? key : min));
}

/** The rolling `SCORE_PERIOD_DAYS` period ending on `endKey` (inclusive). */
export function periodEndingOn(endKey: string): ScorePeriod {
  return { startKey: addDays(endKey, -(SCORE_PERIOD_DAYS - 1)), endKey };
}

/** The period of the same length immediately before `period` — the trend baseline. */
export function previousPeriod(period: ScorePeriod): ScorePeriod {
  return periodEndingOn(addDays(period.startKey, -1));
}

/**
 * The instant range [from, to) a period covers in one driver's home-terminal zone — local
 * midnight starting `startKey` to local midnight ending `endKey`. SafetyEvent.occurredAt is an
 * instant, so it is bucketed here; DailyLog/HosViolation are already keyed by the same local
 * `logDate` and are filtered by the keys directly.
 */
export function periodInstants(timeZone: string, period: ScorePeriod): { from: Date; to: Date } {
  return { from: dayStart(timeZone, period.startKey), to: dayEnd(timeZone, period.endKey) };
}

/** "YYYY-MM-DD" -> the UTC-midnight Date Prisma writes to / compares with a `@db.Date` column
 * (never local-midnight — B-056). */
export function dateKeyToDbDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/** A `@db.Date` value read back from Prisma (UTC midnight) -> "YYYY-MM-DD". */
export function dbDateToKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface RankInput {
  driverId: string;
  /** null = unscored ("Not enough miles") — never ranked. */
  score: number | null;
  milesDriven: number;
  /** Tie-break after miles; "Last, First". */
  name: string;
}

/**
 * #1 = best score. Ties: more miles first, then name, then driverId (so the order is total and
 * reproducible). Unscored drivers get no rank. Ranks are dense positions 1..n (no shared ranks).
 */
export function rankDrivers(rows: readonly RankInput[]): Map<string, number> {
  const ranked = rows
    .filter((r): r is RankInput & { score: number } => r.score !== null)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.milesDriven - a.milesDriven ||
        a.name.localeCompare(b.name) ||
        a.driverId.localeCompare(b.driverId),
    );
  return new Map(ranked.map((r, i) => [r.driverId, i + 1]));
}

/** Mile-weighted mean of the scored drivers' scores, rounded; null when nobody is scored. */
export function fleetScore(rows: ReadonlyArray<{ score: number | null; milesDriven: number }>): number | null {
  let miles = 0;
  let weighted = 0;
  for (const r of rows) {
    if (r.score === null || r.milesDriven <= 0) continue;
    miles += r.milesDriven;
    weighted += r.score * r.milesDriven;
  }
  return miles > 0 ? Math.round(weighted / miles) : null;
}

/** `current - previous`, or null when either side has no score. */
export function scoreTrend(current: number | null, previous: number | null): number | null {
  return current === null || previous === null ? null : current - previous;
}
