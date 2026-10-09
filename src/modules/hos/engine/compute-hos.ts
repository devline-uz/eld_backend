/**
 * TZ §8.3 — `computeHos`. Pure: same input, same output, no clock, no DB, no DI.
 *
 * Algorithm (§8.3):
 *   0. day boundaries from `input.timezone` (= driver.homeTerminalTimezone)
 *   1. normalise  — recordStatus = 1, sort, apply PC/YM
 *   2. segments   — record → next record, last record → `now`
 *   3. shift      — reset on ≥ 10 h (passenger: 8 h) continuous OFF/SB, or on a closed split pair (§8.2.1)
 *   4. limits     — drive, shift window (passenger: 15 h on duty), 30-min break, cycle with recap
 *   5. violations — one per (logDate, type), with the overrun in seconds
 *   6. forecast   — nextBreakDueAt, shiftEndsAt, cycleRecapAt, restartAvailableAt
 */
import type { HosInput, HosState, Violation } from '../hos.types';
import { cycleUsedOn, mergeHistory, onDutyByDay, recapAt, resolveRestartEnd } from './cycle';
import { RESTART_REST, resolveLimits } from './limits';
import { buildSegments, findRestRuns, normalizeEvents, type RestRun, type Segment } from './normalize';
import { analyzeSplits, type SplitPair } from './split-sleeper';
import { dayEnd, dayKey, dayKeysBetween, dayStart } from './timezone';
import { formatHours, ViolationCollector } from './violations';

const SEC = 1000;

interface ShiftState {
  shiftStart: Date | null;
  /** Split-sleeper time excluded from the CURRENT 14-hour window (§8.2.1). */
  excludedSec: number;
  driveUsedSec: number;
  /** ON + D seconds since the last reset — the §395.5(a)(2) passenger 15-hour counter. */
  onDutyUsedSec: number;
  driveSinceBreakSec: number;
  lastBreakEndedAt: Date | null;
}

type Limits = ReturnType<typeof resolveLimits>;

export function computeHos(input: HosInput): HosState {
  const { timezone, now } = input;
  const limits = resolveLimits(input.ruleset, input.driver);
  const events = normalizeEvents(input.events, now);
  // An unauthorised PC/YM tag leaves the recorded status in force (absent flag ⇒ not allowed, B-131).
  const segments = buildSegments(events, now, {
    allowPc: input.driver.allowPersonalConveyance === true,
    allowYm: input.driver.allowYardMove === true,
  });
  const restRuns = findRestRuns(segments, limits.resetRestSec);
  const runByEndIndex = new Map<number, RestRun>();
  for (const run of restRuns) runByEndIndex.set(run.endIndex, run);

  const splits = analyzeSplits(restRuns, input.driver.splitSleeperEnabled !== false, limits.split);
  const violations = new ViolationCollector();

  const state: ShiftState = {
    shiftStart: null,
    excludedSec: 0,
    driveUsedSec: 0,
    onDutyUsedSec: 0,
    driveSinceBreakSec: 0,
    lastBreakEndedAt: null,
  };

  // --- cycle inputs (needed inside the walk only for the final remaining figure) ---
  // §395.3(c) — the 34 h restart is a property-carrying provision; a passenger driver never has one,
  // not even one reported through `lastRestartEndedAt`.
  const restartEnd = limits.restartAllowed ? resolveRestartEnd(restRuns, input.lastRestartEndedAt, now) : null;
  const restartDay = restartEnd ? dayKey(timezone, restartEnd) : null;
  const derived = onDutyByDay(segments, timezone, restartEnd);
  const totalsByDay = mergeHistory(input.previousDays ?? [], derived, restartDay);

  // --- step 3/4/5: one chronological pass over the segments ---
  let nonDriveSec = 0;
  let nonDriveEnd: Date | null = null;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const driving = segment.effective === 'D';

    if (!driving) {
      nonDriveSec += segment.durationSec;
      nonDriveEnd = segment.end;
    } else {
      // §8.2 rule 3 — ANY ≥ 30 min of non-driving (OFF, SB or ON) satisfies the break.
      if (nonDriveSec >= limits.breakMinSec) {
        state.driveSinceBreakSec = 0;
        state.lastBreakEndedAt = nonDriveEnd;
      }
      nonDriveSec = 0;
      nonDriveEnd = null;
    }

    if (segment.effective === 'ON' || driving) {
      if (state.shiftStart === null) {
        state.shiftStart = segment.start;
        state.excludedSec = 0;
      }
    }

    const onDutyBefore = state.onDutyUsedSec;
    if (segment.effective === 'ON' || driving) state.onDutyUsedSec += segment.durationSec;

    if (driving) {
      accrueDriving(segment, state, limits, violations, timezone, onDutyBefore);
    }

    // Rest effects are applied once, at the segment that CLOSES the OFF/SB run.
    const run = runByEndIndex.get(i);
    if (run) {
      const pair = splits.pairCloseByEndIndex.get(i);
      // Every qualifying part that does NOT close a pair is excluded from the window while it
      // waits for its partner — including the FIRST half of a pair that closes later. Missing
      // this is what produced phantom SHIFT_14 violations under the pre-2020 reading (§8.2.1).
      const part = splits.excludedWhilePendingByEndIndex.get(i);
      const fullReset = applyRestRun(run, state, limits, pair ?? null, pair === undefined && part !== undefined, part?.partSec ?? 0, segments);
      // A 10 h reset opens a fresh shift: rest before it is not a break INSIDE that shift (B-132).
      if (fullReset) {
        nonDriveSec = 0;
        nonDriveEnd = null;
      }
    }
  }

  // A trailing non-driving stretch that already reached 30 minutes has satisfied the break.
  if (nonDriveSec >= limits.breakMinSec) {
    state.driveSinceBreakSec = 0;
    state.lastBreakEndedAt = nonDriveEnd;
  }

  // --- cycle violations, day by day (§8.2 rules 4/6) ---
  const todayKey = dayKey(timezone, now);
  collectCycleViolations({ segments, totals: totalsByDay, derived, timezone, todayKey, limits, restartDay, restartEnd, violations });

  const cycleUsed = cycleUsedOn(totalsByDay, todayKey, limits.cycleDays, restartDay);
  const cycleRemainingSec = Math.max(0, limits.cycleLimitSec - cycleUsed);

  // --- step 6: forecast ---
  const { shiftEndsAt, shiftRemainingSec } = shiftForecast(state, limits, now);

  const breakRemainingSec = limits.breakRequired
    ? Math.max(0, limits.breakAfterSec - state.driveSinceBreakSec)
    : limits.breakAfterSec;

  const last = segments[segments.length - 1];
  const currentlyDriving = last?.effective === 'D';
  const nextBreakDueAt = !limits.breakRequired
    ? null
    : breakRemainingSec <= 0
      ? now
      : currentlyDriving
        ? new Date(now.getTime() + breakRemainingSec * SEC)
        : null;

  // Driving time left before the driver must stop: the 11 h limit, the 14 h window and the
  // cycle all cap it. The 30-minute break is reported separately (`breakRemainingSec`) — it
  // pauses driving but does not shorten the day, so it must not shrink this number (§8.1).
  const driveRemainingSec = Math.max(0, Math.min(limits.driveLimitSec - state.driveUsedSec, shiftRemainingSec, cycleRemainingSec));

  const openRest = last && (last.effective === 'OFF' || last.effective === 'SB') ? restRuns[restRuns.length - 1] : null;
  // §395.3(c) — no restart to forecast for a passenger-carrying driver.
  const restartAvailableAt = openRest && limits.restartAllowed ? new Date(openRest.start.getTime() + RESTART_REST * SEC) : null;

  return {
    currentStatus: last ? last.effective : (events[events.length - 1]?.status ?? 'OFF'),
    statusSince: last ? last.start : (events[events.length - 1]?.at ?? now),
    driveRemainingSec,
    shiftRemainingSec,
    breakRemainingSec,
    cycleRemainingSec,
    driveUsedSec: state.driveUsedSec,
    shiftStartedAt: state.shiftStart,
    lastBreakEndedAt: state.lastBreakEndedAt,
    violations: violations.list(),
    nextBreakDueAt,
    shiftEndsAt,
    cycleRecapAt: recapAt(totalsByDay, timezone, now, limits.cycleDays, restartDay),
    restartAvailableAt,
    dailyTotals: dailyTotals(segments, timezone, todayKey, now),
  };
}

/**
 * The shift limit, as seen from `now`.
 *   WINDOW  (property, §395.3(a)(2)) — the fixed end of the 14 h window, stretched by excluded split time.
 *   ON_DUTY (passenger, §395.5(a)(2)) — 15 h minus the ON + D time used since the last reset; the end is
 *           a projection (`now` + remaining): it is reached only if the driver stays on duty from now.
 */
function shiftForecast(state: ShiftState, limits: Limits, now: Date): { shiftEndsAt: Date | null; shiftRemainingSec: number } {
  if (!state.shiftStart) return { shiftEndsAt: null, shiftRemainingSec: limits.shiftLimitSec };
  if (limits.shiftMode === 'ON_DUTY') {
    const shiftRemainingSec = Math.max(0, limits.shiftLimitSec - state.onDutyUsedSec);
    return { shiftEndsAt: new Date(now.getTime() + shiftRemainingSec * SEC), shiftRemainingSec };
  }
  const shiftEndsAt = new Date(state.shiftStart.getTime() + (limits.shiftLimitSec + state.excludedSec) * SEC);
  return { shiftEndsAt, shiftRemainingSec: Math.max(0, Math.round((shiftEndsAt.getTime() - now.getTime()) / SEC)) };
}

/** Driving time accrual plus the three shift-level violation checks (§8.2 rules 1/2/3). */
function accrueDriving(
  segment: Segment,
  state: ShiftState,
  limits: Limits,
  violations: ViolationCollector,
  timezone: string,
  onDutyBefore: number,
): void {
  const driveBefore = state.driveUsedSec;
  const breakBefore = state.driveSinceBreakSec;
  state.driveUsedSec += segment.durationSec;
  state.driveSinceBreakSec += segment.durationSec;

  // Rule 1 — 11 h driving (13 h with adverse conditions).
  if (state.driveUsedSec > limits.driveLimitSec) {
    const at = new Date(segment.start.getTime() + Math.max(0, limits.driveLimitSec - driveBefore) * SEC);
    violations.add(
      'DRIVING_11',
      dayKey(timezone, at),
      at,
      state.driveUsedSec - limits.driveLimitSec,
      `Drove ${formatHours(state.driveUsedSec)} against a ${formatHours(limits.driveLimitSec)} driving limit`,
    );
  }

  // Rule 3 — 30-minute break after 8 h of cumulative driving.
  if (limits.breakRequired && state.driveSinceBreakSec > limits.breakAfterSec) {
    const at = new Date(segment.start.getTime() + Math.max(0, limits.breakAfterSec - breakBefore) * SEC);
    violations.add(
      'BREAK_30',
      dayKey(timezone, at),
      at,
      state.driveSinceBreakSec - limits.breakAfterSec,
      `Drove ${formatHours(state.driveSinceBreakSec)} without a ${Math.round(limits.breakMinSec / 60)}-minute break`,
    );
  }

  // Passenger rule 2 — §395.5(a)(2): no DRIVING after 15 h ON DUTY since the last 8 h reset. Off-duty
  // and sleeper time do not count; on-duty-not-driving past 15 h is not itself a violation.
  if (limits.shiftMode === 'ON_DUTY') {
    if (state.onDutyUsedSec > limits.shiftLimitSec) {
      const at = new Date(segment.start.getTime() + Math.max(0, limits.shiftLimitSec - onDutyBefore) * SEC);
      violations.add(
        'SHIFT_14',
        dayKey(timezone, at),
        at,
        state.onDutyUsedSec - limits.shiftLimitSec,
        `Drove after ${formatHours(state.onDutyUsedSec)} on duty against a ${formatHours(limits.shiftLimitSec)} on-duty limit`,
      );
    }
    return;
  }

  // Rule 2 — the 14 h window. It pauses for nothing; only qualifying split-sleeper time is
  // excluded from it (§8.2.1), which is what `excludedSec` carries.
  if (state.shiftStart) {
    const windowEnd = state.shiftStart.getTime() + (limits.shiftLimitSec + state.excludedSec) * SEC;
    if (segment.end.getTime() > windowEnd) {
      const at = new Date(Math.max(segment.start.getTime(), windowEnd));
      violations.add(
        'SHIFT_14',
        dayKey(timezone, at),
        at,
        (segment.end.getTime() - windowEnd) / SEC,
        `Drove ${formatHours((segment.end.getTime() - state.shiftStart.getTime()) / SEC - state.excludedSec)} into a ${formatHours(limits.shiftLimitSec)} window`,
      );
    }
  }
}

/**
 * §8.2 rule 1 / §395.1(g)(1) — what a completed rest run does to the shift.
 *   ≥ 10 h continuous OFF/SB      → full reset, both clocks to zero (returns true)
 *   closing half of a split pair  → CFR LOOK-BACK (see `applySplitLookBack`)
 *   unpaired qualifying part      → excluded from the window, driving time keeps accumulating
 */
function applyRestRun(
  run: RestRun,
  state: ShiftState,
  limits: Limits,
  closingPair: SplitPair | null,
  isPendingPart: boolean,
  pendingPartSec: number,
  segments: Segment[],
): boolean {
  // 10 h property (§395.3(a)(1)), 8 h passenger (§395.5(a)).
  if (run.durationSec >= limits.resetRestSec) {
    state.shiftStart = null;
    state.excludedSec = 0;
    state.driveUsedSec = 0;
    state.onDutyUsedSec = 0;
    state.driveSinceBreakSec = 0;
    // `lastBreakEndedAt` is shift-scoped: the new shift has had no 30-minute break yet (B-132).
    state.lastBreakEndedAt = null;
    return true;
  }
  if (closingPair) {
    applySplitLookBack(run, state, closingPair, segments);
    return false;
  }
  if (isPendingPart && state.shiftStart !== null) {
    state.excludedSec += pendingPartSec;
  }
  return false;
}

/**
 * 49 CFR §395.1(g)(1) — the look-back, NOT a reset (see `backend/decisions.md` D-012).
 *
 * When the SECOND qualifying period ends, the driver does not start from zero. They look BACK
 * to the end of the FIRST qualifying period and recompute both clocks from there:
 *   • the 11 h driving clock carries the driving done BETWEEN the two qualifying periods;
 *   • the 14 h window restarts at the end of the first period, with the second qualifying
 *     period excluded from it (both qualifying periods are outside the window, per the
 *     2020-09-29 amendment).
 *
 * `tz.md` §8.2.1 says the counters reset from the END of the second part. That is more
 * permissive than the CFR — with 8 h SB → 4 h D → 2 h SB it leaves 11 h of driving where the
 * CFR leaves 7 h — and it under-reports DRIVING_11 and SHIFT_14. §395 outranks `tz.md`, so
 * the look-back wins and §8.2.1 is marked superseded.
 *
 * Passenger (§395.1(g)(3)): the same look-back — the 10 h driving and 15 h on-duty counters carry
 * only the time between the two sleeper periods. `excludedSec` is irrelevant there (ON_DUTY mode).
 */
function applySplitLookBack(run: RestRun, state: ShiftState, pair: SplitPair, segments: Segment[]): void {
  state.shiftStart = pair.first.end;
  // Only the SECOND qualifying period falls inside the new window; the first one ends where
  // the window begins. Any non-qualifying rest between them stays in the window (§395.1(g)(1)).
  state.excludedSec = pair.second.partSec;
  state.driveUsedSec = statusSecondsBetween(segments, pair.first.end, run.end, false);
  state.onDutyUsedSec = statusSecondsBetween(segments, pair.first.end, run.end, true);
  // The shorter half is ≥ 2 h of non-driving, which always satisfies the 30-minute break.
  state.driveSinceBreakSec = 0;
  state.lastBreakEndedAt = run.end;
}

/** Driving (or, with `includeOnDuty`, ON + D) seconds inside [from, to), used by the §395.1(g) look-back. */
function statusSecondsBetween(segments: Segment[], from: Date, to: Date, includeOnDuty: boolean): number {
  let seconds = 0;
  for (const segment of segments) {
    if (segment.effective !== 'D' && !(includeOnDuty && segment.effective === 'ON')) continue;
    const start = Math.max(segment.start.getTime(), from.getTime());
    const end = Math.min(segment.end.getTime(), to.getTime());
    if (end > start) seconds += Math.round((end - start) / SEC);
  }
  return seconds;
}

interface CycleScan {
  segments: Segment[];
  /** Merged per-day ON + D totals (history + segments). */
  totals: Map<string, number>;
  /** Per-day ON + D totals derived from the segments alone. */
  derived: Map<string, number>;
  timezone: string;
  todayKey: string;
  limits: Limits;
  restartDay: string | null;
  restartEnd: Date | null;
  violations: ViolationCollector;
}

/**
 * §395.3(b) (property) and §395.5(b) (passenger) prohibit DRIVING after 60/70 h on duty in 7/8
 * days — not being on duty. A cycle violation is therefore recorded only for driving done while
 * the day's sliding-window total is past the limit, exactly like the 14-hour rule: on-duty-not-
 * driving past the cycle is legal (1.0.3; was flagged by 1.0.2).
 *   occurredAt    — the first instant of driving past the limit that day
 *   exceededBySec — window total at the end of the last offending driving stretch, minus the limit
 * On-duty hours that only `previousDays` knows about for a day (more than its segments show) carry
 * no timing, so they are counted at the START of that day — never the more generous reading — and,
 * having no driving attached, cannot by themselves produce a violation.
 */
function collectCycleViolations(scan: CycleScan): void {
  const { segments, totals, derived, timezone, todayKey, limits, restartDay, restartEnd, violations } = scan;
  const limit = limits.cycleLimitSec;
  const keys = segments.length ? dayKeysBetween(timezone, segments[0].start, new Date(Math.max(segments[segments.length - 1].end.getTime() - 1, segments[0].start.getTime()))) : [];
  if (!keys.includes(todayKey)) keys.push(todayKey);
  const cutoff = restartEnd ? restartEnd.getTime() : Number.NEGATIVE_INFINITY;
  for (const key of keys) {
    const used = cycleUsedOn(totals, key, limits.cycleDays, restartDay);
    if (used <= limit) continue;
    const dayTotal = totals.get(key) ?? 0;
    const excess = Math.max(0, dayTotal - (derived.get(key) ?? 0));
    let running = used - dayTotal + excess;
    const from = Math.max(dayStart(timezone, key).getTime(), cutoff);
    const to = dayEnd(timezone, key).getTime();
    for (const segment of segments) {
      if (segment.effective !== 'ON' && segment.effective !== 'D') continue;
      const start = Math.max(segment.start.getTime(), from);
      const end = Math.min(segment.end.getTime(), to);
      if (end <= start) continue;
      const seconds = (end - start) / SEC;
      if (segment.effective === 'D' && running + seconds > limit) {
        const at = new Date(start + Math.max(0, limit - running) * SEC);
        const over = running + seconds - limit;
        violations.add(
          limits.cycleViolationType,
          key,
          at,
          over,
          `Drove with ${formatHours(running + seconds)} on duty in ${limits.cycleDays} days against a ${formatHours(limit)} cycle`,
        );
      }
      running += seconds;
    }
  }
}

/** §8.3 step 0 — totals for the RODS day that contains `now`, in the home terminal timezone. */
function dailyTotals(segments: Segment[], timezone: string, todayKey: string, now: Date): HosState['dailyTotals'] {
  const from = dayStart(timezone, todayKey).getTime();
  const to = Math.min(dayEnd(timezone, todayKey).getTime(), now.getTime());
  const totals = { off: 0, sb: 0, drive: 0, on: 0 };
  for (const segment of segments) {
    const start = Math.max(segment.start.getTime(), from);
    const end = Math.min(segment.end.getTime(), to);
    if (end <= start) continue;
    const seconds = Math.round((end - start) / SEC);
    if (segment.effective === 'OFF') totals.off += seconds;
    else if (segment.effective === 'SB') totals.sb += seconds;
    else if (segment.effective === 'D') totals.drive += seconds;
    else totals.on += seconds;
  }
  return totals;
}

export type { Violation };
