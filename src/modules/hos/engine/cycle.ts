/**
 * §8.2 rules 4/5/6 — cycle, 34-hour restart and recap.
 *
 * The cycle is a SLIDING window over per-day on-duty totals (ON + D). It is deliberately
 * driven by `previousDays[]` — one entry per day — because a single summed number cannot
 * express "the hours from 8 days ago come back today" (§8.1).
 */
import type { PreviousDay } from '../hos.types';
import { RESTART_REST } from './limits';
import type { RestRun, Segment } from './normalize';
import { addDays, dayEnd, dayKey, dayKeysBetween, dayStart } from './timezone';

export interface DayOnDuty {
  /** date key → ON + D seconds counting against the cycle. */
  totals: Map<string, number>;
}

/** The instant the most recent 34 h restart ended, or null. */
export function resolveRestartEnd(runs: RestRun[], lastRestartEndedAt: Date | null, now: Date): Date | null {
  let end: Date | null = lastRestartEndedAt && lastRestartEndedAt.getTime() <= now.getTime() ? lastRestartEndedAt : null;
  for (const run of runs) {
    if (run.durationSec < RESTART_REST) continue;
    // The restart is complete at the 34th hour, not when the driver finally goes back on duty:
    // rest beyond that point adds no on-duty time, so the earlier instant is equivalent for the
    // cycle and keeps one more day of `previousDays` in scope (never the more generous reading).
    const candidate = new Date(run.start.getTime() + RESTART_REST * 1000);
    if (candidate.getTime() > now.getTime()) continue;
    if (!end || candidate.getTime() > end.getTime()) end = candidate;
  }
  return end;
}

/**
 * Per-day ON + D seconds derived from the segments, split at LOCAL midnights so a shift that
 * runs past midnight is billed to both RODS days. Time before `cutoff` (the end of a 34 h
 * restart) is dropped: those hours no longer count against the cycle.
 */
export function onDutyByDay(segments: Segment[], timezone: string, cutoff: Date | null): Map<string, number> {
  const totals = new Map<string, number>();
  for (const segment of segments) {
    if (segment.effective !== 'ON' && segment.effective !== 'D') continue;
    let from = segment.start;
    if (cutoff && cutoff.getTime() > from.getTime()) from = cutoff;
    if (from.getTime() >= segment.end.getTime()) continue;
    for (const key of dayKeysBetween(timezone, from, new Date(segment.end.getTime() - 1))) {
      const sliceStart = Math.max(from.getTime(), dayStart(timezone, key).getTime());
      const sliceEnd = Math.min(segment.end.getTime(), dayEnd(timezone, key).getTime());
      if (sliceEnd <= sliceStart) continue;
      totals.set(key, (totals.get(key) ?? 0) + Math.round((sliceEnd - sliceStart) / 1000));
    }
  }
  return totals;
}

/**
 * Merges the caller's history with the segment-derived totals. Where both describe the same
 * day the larger value wins: `previousDays` is authoritative for days with no events left in
 * the recalculation range, and the segments are authoritative for the days they cover.
 */
export function mergeHistory(previousDays: PreviousDay[], derived: Map<string, number>, restartDay: string | null): Map<string, number> {
  const totals = new Map<string, number>(derived);
  for (const day of previousDays) {
    if (restartDay && day.date < restartDay) continue;
    const seconds = Math.max(0, Math.round(day.onDutySec));
    totals.set(day.date, Math.max(totals.get(day.date) ?? 0, seconds));
  }
  return totals;
}

/** On-duty seconds inside the `cycleDays`-day window that ENDS on `key` (inclusive). */
export function cycleUsedOn(totals: Map<string, number>, key: string, cycleDays: number, restartDay: string | null): number {
  let used = 0;
  for (let back = 0; back < cycleDays; back += 1) {
    const day = addDays(key, -back);
    if (restartDay && day < restartDay) continue;
    used += totals.get(day) ?? 0;
  }
  return used;
}

/**
 * §8.2 rule 6 — recap. The next local midnight at which hours come back, i.e. when the oldest
 * day of the sliding window drops out. Null when nothing would be returned.
 */
export function recapAt(totals: Map<string, number>, timezone: string, now: Date, cycleDays: number): Date | null {
  const today = dayKey(timezone, now);
  const dropping = addDays(today, -(cycleDays - 1));
  return (totals.get(dropping) ?? 0) > 0 ? dayEnd(timezone, today) : null;
}
