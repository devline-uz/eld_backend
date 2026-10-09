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

/** 49 CFR §395.5(a)(1)/(a)(2) — passenger-carrying: the counters reset after 8 consecutive hours off duty. */
export const RESET_REST_PASSENGER = 8 * HOUR;
/** 49 CFR §395.1(g)(3) — passenger sleeper berth: two SB periods, each ≥ 2 h, together ≥ 8 h. */
export const SPLIT_PASSENGER_PART_MIN = 2 * HOUR;
export const SPLIT_PASSENGER_PAIR_MIN = 8 * HOUR;

export const CYCLE_70 = 70 * HOUR;
export const CYCLE_60 = 60 * HOUR;

/** §8.2 rule 10 — PC position may be recorded at 10-mile precision. */
export const PC_LOCATION_PRECISION_MI = 10;

/**
 * Which periods qualify as split-sleeper parts and when two of them pair up.
 *   property  — §395.1(g)(1)(ii): one ≥ 7 h SB part + one ≥ 2 h SB-or-OFF part, ≥ 10 h together.
 *   passenger — §395.1(g)(3): two SB parts, each ≥ 2 h, ≥ 8 h together (OFF never qualifies).
 */
export interface SplitRule {
  /** Continuous SB seconds that make a run a LONG part (a part every pair needs at least one of). */
  longMinSec: number;
  /** Seconds that make a run a SHORT part; only consulted when `shortMayBeOffDuty`. */
  shortMinSec: number;
  /** Property: the shorter part may be off duty. Passenger: both parts must be sleeper berth. */
  shortMayBeOffDuty: boolean;
  pairMinSec: number;
}

export const PROPERTY_SPLIT: SplitRule = {
  longMinSec: SPLIT_LONG_MIN,
  shortMinSec: SPLIT_SHORT_MIN,
  shortMayBeOffDuty: true,
  pairMinSec: SPLIT_PAIR_MIN,
};

export const PASSENGER_SPLIT: SplitRule = {
  longMinSec: SPLIT_PASSENGER_PART_MIN,
  shortMinSec: SPLIT_PASSENGER_PART_MIN,
  shortMayBeOffDuty: false,
  pairMinSec: SPLIT_PASSENGER_PAIR_MIN,
};

/**
 * How the shift limit is measured.
 *   WINDOW  — property, §395.3(a)(2): an elapsed 14 h window from the first on-duty record; it
 *             pauses for nothing except qualifying split-sleeper time.
 *   ON_DUTY — passenger, §395.5(a)(2): 15 h of ON + D time since the last 8 h reset; off-duty and
 *             sleeper time between does NOT count, so it is not an elapsed window.
 */
export type ShiftMode = 'WINDOW' | 'ON_DUTY';

export interface RuleLimits {
  driveLimitSec: number;
  shiftLimitSec: number;
  shiftMode: ShiftMode;
  /** Consecutive OFF/SB seconds that reset the drive and shift counters (10 h property, 8 h passenger). */
  resetRestSec: number;
  /** §395.3(c) — the 34 h restart exists for property-carrying drivers only. */
  restartAllowed: boolean;
  split: SplitRule;
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
    shiftMode: passenger ? 'ON_DUTY' : 'WINDOW',
    resetRestSec: passenger ? RESET_REST_PASSENGER : RESET_REST,
    restartAllowed: !passenger,
    split: passenger ? PASSENGER_SPLIT : PROPERTY_SPLIT,
    cycleLimitSec: sixtySeven ? CYCLE_60 : CYCLE_70,
    cycleDays: sixtySeven ? 7 : 8,
    cycleViolationType: sixtySeven ? 'CYCLE_60' : 'CYCLE_70',
    breakRequired: !passenger && driver.shortHaulException !== true,
    breakAfterSec: BREAK_AFTER_DRIVING,
    breakMinSec: BREAK_MIN_DURATION,
    adverseApplied: adverse,
  };
}
