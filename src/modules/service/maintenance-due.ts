/**
 * TZ §5.10 — maintenance due/overdue detection. A schedule can be interval-by-mileage,
 * interval-by-date, or both (whichever trips first wins — a truck driven hard hits its mileage
 * interval before its date interval, and vice versa for a truck that sits).
 */
export interface DueCheckInput {
  intervalMi: number | null;
  intervalDays: number | null;
  lastServiceMi: number | null;
  lastServiceAt: Date | null;
  currentOdometerMi: number;
  now: Date;
  /** QA CODE-037 — where the interval counts from when no service was ever recorded: the odometer
   * and time the schedule was created. `null`/absent = unknown, and that interval is not evaluated
   * (it used to count from 0 mi / 1970, so a new schedule was thousands of days overdue at once). */
  baselineMi?: number | null;
  baselineAt?: Date | null;
}

export type DueState = 'OK' | 'DUE_SOON' | 'OVERDUE';

export interface DueResult {
  state: DueState;
  nextDueMi: number | null;
  nextDueAt: Date | null;
  milesRemaining: number | null;
  daysRemaining: number | null;
}

/** Warn inside this many miles / days of the due point (fleet-desk convention: give the
 * scheduler a heads-up before it becomes a hard overdue). */
export const DUE_SOON_MILES = 500;
export const DUE_SOON_DAYS = 7;

export function computeDue(input: DueCheckInput): DueResult {
  const fromMi = input.lastServiceMi ?? input.baselineMi ?? null;
  const fromAt = input.lastServiceAt ?? input.baselineAt ?? null;
  const nextDueMi = input.intervalMi != null && fromMi != null ? fromMi + input.intervalMi : null;
  const nextDueAt = input.intervalDays != null && fromAt != null ? addDays(fromAt, input.intervalDays) : null;

  const milesRemaining = nextDueMi != null ? nextDueMi - input.currentOdometerMi : null;
  const daysRemaining = nextDueAt != null ? diffDays(nextDueAt, input.now) : null;

  const overdue = (milesRemaining !== null && milesRemaining <= 0) || (daysRemaining !== null && daysRemaining <= 0);
  const dueSoon =
    !overdue &&
    ((milesRemaining !== null && milesRemaining <= DUE_SOON_MILES) ||
      (daysRemaining !== null && daysRemaining <= DUE_SOON_DAYS));

  return {
    state: overdue ? 'OVERDUE' : dueSoon ? 'DUE_SOON' : 'OK',
    nextDueMi,
    nextDueAt,
    milesRemaining,
    daysRemaining,
  };
}

/** Before this, a stored `nextDue*` was computed from 0 mi / 1970 — not a real baseline. */
const LEGACY_EPOCH_CUTOFF_MS = Date.UTC(2000, 0, 1);

/**
 * QA CODE-037 — the baseline a stored schedule counts from while it has no recorded service.
 * `create` folds the odometer and date at creation into `nextDueMi` / `nextDueAt` (= baseline +
 * interval), so the baseline is recovered by subtracting the interval. A row saved by the old code
 * (counted from 0 mi / 1970) yields a non-positive mileage or pre-2000 date — treated as unknown,
 * so that interval is not evaluated instead of raising a nightly "overdue by 20,000 days" alert.
 */
export function scheduleBaseline(schedule: {
  intervalMi: number | null;
  intervalDays: number | null;
  nextDueMi: number | null;
  nextDueAt: Date | null;
}): { baselineMi: number | null; baselineAt: Date | null } {
  const mi = schedule.intervalMi != null && schedule.nextDueMi != null ? schedule.nextDueMi - schedule.intervalMi : null;
  const at = schedule.intervalDays != null && schedule.nextDueAt != null ? addDays(schedule.nextDueAt, -schedule.intervalDays) : null;
  return {
    baselineMi: mi != null && mi > 0 ? mi : null,
    baselineAt: at != null && at.getTime() >= LEGACY_EPOCH_CUTOFF_MS ? at : null,
  };
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function diffDays(future: Date, now: Date): number {
  return Math.ceil((future.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}
