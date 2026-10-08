/**
 * TZ §8.1 — the language-neutral HOS contract. These types are mirrored 1:1 by the Dart
 * engine (`lib/core/hos/engine/` in the mobile repo) and by the JSON conformance fixtures in
 * `test/conformance/golden/`. Nothing here may import Prisma, Nest or any I/O module:
 * the string unions below intentionally repeat the Prisma enums instead of importing them
 * so that `hos/` stays a pure, dependency-free package (TZ §3.5 exception, §8.6).
 */

/** §5.5 eventType 1 duty statuses. */
export type DutyStatus = 'OFF' | 'SB' | 'D' | 'ON';

/** §8.2 rules 10/11 — special driving categories. */
export type SpecialDrivingCategory = 'NONE' | 'PC' | 'YM';

/** Prisma `HosRuleset`. */
export type HosRuleset =
  | 'US_70_8_PROPERTY'
  | 'US_60_7_PROPERTY'
  | 'US_70_8_PASSENGER'
  | 'US_60_7_PASSENGER';

/** Prisma `ViolationType` — FORM_MANNER is produced by the logs module, not by this engine. */
export type ViolationType =
  | 'DRIVING_11'
  | 'SHIFT_14'
  | 'BREAK_30'
  | 'CYCLE_70'
  | 'CYCLE_60'
  | 'FORM_MANNER';

/**
 * One §395 duty-status record, already filtered to `recordStatus = 1` and sorted.
 * `at` is an absolute instant; the wall-clock day it belongs to is derived from
 * `HosInput.timezone` (the driver's HOME TERMINAL), never from the device offset.
 */
export interface NormalizedEvent {
  at: Date;
  status: DutyStatus;
  /** §8.2 rules 10/11. PC ⇒ counted as OFF, YM ⇒ counted as ON; neither is driving time. */
  special?: SpecialDrivingCategory;
  /** §5.5 — stable per-driver ordering key, used only as a sort tie-breaker. */
  eventSequenceId?: number;
  /** Defaults to 1 (ACTIVE). Anything else is dropped. */
  recordStatus?: number;
  /** §8.2 rule 10 — PC location precision, in miles. Informational, carried through. */
  locationPrecisionMi?: number;
}

/** Per-driver exception flags (Prisma `Driver`). */
export interface DriverHosConfig {
  driverId: string;
  allowPersonalConveyance?: boolean;
  allowYardMove?: boolean;
  adverseDrivingEnabled?: boolean;
  shortHaulException?: boolean;
  splitSleeperEnabled?: boolean;
}

export interface PreviousDay {
  /** "YYYY-MM-DD" in the home-terminal timezone. */
  date: string;
  /** ON + D seconds for that day — the time that counts against the cycle. */
  onDutySec: number;
}

export interface HosInput {
  events: NormalizedEvent[];
  driver: DriverHosConfig;
  ruleset: HosRuleset;
  now: Date;
  /** driver.homeTerminalTimezone — NOT Carrier.timezone (§8 hard rule). */
  timezone: string;
  previousDays: PreviousDay[];
  lastRestartEndedAt: Date | null;
}

export interface Violation {
  type: ViolationType;
  /** "YYYY-MM-DD" in the home-terminal timezone. */
  logDate: string;
  occurredAt: Date;
  exceededBySec: number;
  detail: string;
}

export interface HosState {
  currentStatus: DutyStatus;
  statusSince: Date;
  driveRemainingSec: number;
  shiftRemainingSec: number;
  breakRemainingSec: number;
  cycleRemainingSec: number;
  driveUsedSec: number;
  shiftStartedAt: Date | null;
  lastBreakEndedAt: Date | null;
  violations: Violation[];
  nextBreakDueAt: Date | null;
  shiftEndsAt: Date | null;
  cycleRecapAt: Date | null;
  restartAvailableAt: Date | null;
  dailyTotals: { off: number; sb: number; drive: number; on: number };
}
