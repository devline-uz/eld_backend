/**
 * W-08 (web panel only) — violations still in force when a RODS day OPENS.
 *
 * The HOS engine files a violation on the RODS day its limit was crossed (one row per
 * `(driverId, logDate, type)`, see `hos/engine/violations.ts`). A driver who crosses the 11-hour
 * limit on Monday and is still driving, with no 10-hour reset, through Tuesday therefore has a
 * Tuesday log that is 24:00 of driving in violation — yet no Tuesday row. The engine and its Dart
 * mirror are shared with the mobile app and are deliberately not changed here; this read-only
 * helper runs the SAME engine at the day's first instant and reports which shift-level limits
 * the driving that carries over midnight is still breaking. The cycle is not reported: the engine
 * already files a cycle violation on every day with driving past the limit.
 *
 * Pure on purpose (no Prisma, no Nest), like `rods.ts`.
 */
import { computeHos } from '../hos/engine/compute-hos';
import { resolveLimits } from '../hos/engine/limits';
import { mapEldEventsToNormalized } from '../hos/hos-event-mapper';
import type { DriverHosConfig, HosRuleset, ViolationType } from '../hos/hos.types';
import { activeRecords, type RodsEvent } from './rods';

export interface OngoingViolation {
  type: Extract<ViolationType, 'DRIVING_11' | 'SHIFT_14' | 'BREAK_30'>;
  /** The day's first instant: the violating driving was already under way at 00:00. */
  inForceSince: Date;
  /** The instant the limit was first crossed, on an earlier RODS day. */
  crossedAt: Date | null;
  detail: string;
}

export interface OngoingViolationInput {
  /** Records up to `dayStartAt`, with enough history for the running shift (any status). */
  events: RodsEvent[];
  driver: DriverHosConfig;
  ruleset: HosRuleset;
  timezone: string;
  dayStartAt: Date;
  now: Date;
}

const SEC = 1000;

export function ongoingViolationsAtDayStart(input: OngoingViolationInput): OngoingViolation[] {
  const { dayStartAt, now } = input;
  // A day that has not started yet carries nothing over.
  if (dayStartAt.getTime() > now.getTime()) return [];

  const before = activeRecords(input.events).filter((event) => event.eventDateTime.getTime() < dayStartAt.getTime());
  if (!before.length) return [];

  const state = computeHos({
    events: mapEldEventsToNormalized(before),
    driver: input.driver,
    ruleset: input.ruleset,
    now: dayStartAt,
    timezone: input.timezone,
    previousDays: [],
    lastRestartEndedAt: null,
  });
  // Only DRIVING that runs over midnight keeps a shift-level violation going (§395.3(a)).
  if (state.currentStatus !== 'D') return [];

  const limits = resolveLimits(input.ruleset, input.driver);
  const out: OngoingViolation[] = [];

  if (state.driveUsedSec >= limits.driveLimitSec) {
    const crossedAt = new Date(dayStartAt.getTime() - (state.driveUsedSec - limits.driveLimitSec) * SEC);
    out.push({
      type: 'DRIVING_11',
      inForceSince: dayStartAt,
      crossedAt,
      detail: `Still driving past the ${hours(limits.driveLimitSec)}-hour driving limit at the start of the day, with no ${hours(limits.resetRestSec)}-hour break`,
    });
  }
  if (state.shiftStartedAt && state.shiftRemainingSec <= 0) {
    out.push({
      type: 'SHIFT_14',
      inForceSince: dayStartAt,
      // Passenger `shiftEndsAt` is a projection from `now`, not the instant the limit was crossed.
      crossedAt: limits.shiftMode === 'WINDOW' ? state.shiftEndsAt : null,
      detail: `Still driving after the ${hours(limits.shiftLimitSec)}-hour ${limits.shiftMode === 'WINDOW' ? 'window closed' : 'on-duty limit'}, with no ${hours(limits.resetRestSec)}-hour break`,
    });
  }
  if (limits.breakRequired && state.breakRemainingSec <= 0) {
    out.push({
      type: 'BREAK_30',
      inForceSince: dayStartAt,
      crossedAt: null,
      detail: `Still driving without the ${Math.round(limits.breakMinSec / 60)}-minute break due after ${hours(limits.breakAfterSec)} hours of driving`,
    });
  }
  return out;
}

function hours(seconds: number): number {
  return Math.round(seconds / 3600);
}
