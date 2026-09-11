/** TZ §8.2 — the numeric limits, in seconds, per ruleset and per active exception. */
import type { DriverHosConfig, HosRuleset, ViolationType } from '../hos.types';

export const HOUR = 3600;
export const MINUTE = 60;

export const DRIVE_LIMIT_PROPERTY = 11 * HOUR;
export const DRIVE_LIMIT_PASSENGER = 10 * HOUR;
export const SHIFT_LIMIT_PROPERTY = 14 * HOUR;
export const SHIFT_LIMIT_PASSENGER = 15 * HOUR;
/** §8.2 rule 8 — adverse driving conditions: 11→13 and 14→16. */
export const ADVERSE_DRIVE_BONUS = 2 * HOUR;
export const ADVERSE_SHIFT_BONUS = 2 * HOUR;

/** §8.2 rule 3 — 30 minutes of non-driving after 8 cumulative hours of driving. */
export const BREAK_AFTER_DRIVING = 8 * HOUR;
export const BREAK_MIN_DURATION = 30 * MINUTE;

/** §8.2 rules 1/5/7 — full reset, restart and split-sleeper thresholds. */
export const RESET_REST = 10 * HOUR;
export const RESTART_REST = 34 * HOUR;
export const SPLIT_LONG_MIN = 7 * HOUR;
export const SPLIT_SHORT_MIN = 2 * HOUR;
export const SPLIT_PAIR_MIN = 10 * HOUR;

export const CYCLE_70 = 70 * HOUR;
export const CYCLE_60 = 60 * HOUR;

/** §8.2 rule 10 — PC position may be recorded at 10-mile precision. */
export const PC_LOCATION_PRECISION_MI = 10;

export interface RuleLimits {
  driveLimitSec: number;
  shiftLimitSec: number;
  cycleLimitSec: number;
  /** 8 for 70/8, 7 for 60/7 — the sliding recap window, in days. */
  cycleDays: number;
  cycleViolationType: Extract<ViolationType, 'CYCLE_70' | 'CYCLE_60'>;
  /** Passenger-carrying and short-haul drivers are not subject to §395.3(a)(3)(ii). */
  breakRequired: boolean;
  breakAfterSec: number;
  breakMinSec: number;
  adverseApplied: boolean;
}

const SIXTY_SEVEN: HosRuleset[] = ['US_60_7_PROPERTY', 'US_60_7_PASSENGER'];
const PASSENGER: HosRuleset[] = ['US_70_8_PASSENGER', 'US_60_7_PASSENGER'];

export function isPassenger(ruleset: HosRuleset): boolean {
  return PASSENGER.includes(ruleset);
}

export function resolveLimits(ruleset: HosRuleset, driver: DriverHosConfig): RuleLimits {
  const passenger = isPassenger(ruleset);
  const sixtySeven = SIXTY_SEVEN.includes(ruleset);
  const adverse = driver.adverseDrivingEnabled === true;
  return {
    driveLimitSec: (passenger ? DRIVE_LIMIT_PASSENGER : DRIVE_LIMIT_PROPERTY) + (adverse ? ADVERSE_DRIVE_BONUS : 0),
    shiftLimitSec: (passenger ? SHIFT_LIMIT_PASSENGER : SHIFT_LIMIT_PROPERTY) + (adverse ? ADVERSE_SHIFT_BONUS : 0),
    cycleLimitSec: sixtySeven ? CYCLE_60 : CYCLE_70,
    cycleDays: sixtySeven ? 7 : 8,
    cycleViolationType: sixtySeven ? 'CYCLE_60' : 'CYCLE_70',
    breakRequired: !passenger && driver.shortHaulException !== true,
    breakAfterSec: BREAK_AFTER_DRIVING,
    breakMinSec: BREAK_MIN_DURATION,
    adverseApplied: adverse,
  };
}
