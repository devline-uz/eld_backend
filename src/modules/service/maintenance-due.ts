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
  const nextDueMi = input.intervalMi != null ? (input.lastServiceMi ?? 0) + input.intervalMi : null;
  const nextDueAt =
    input.intervalDays != null
      ? addDays(input.lastServiceAt ?? new Date(0), input.intervalDays)
      : null;

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

function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function diffDays(future: Date, now: Date): number {
  return Math.ceil((future.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}
