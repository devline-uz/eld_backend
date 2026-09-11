/**
 * TZ §5.5 — §395 Appendix A event type/code vocabulary, plus the malfunction and diagnostic
 * code sets from §7.8. Kept as one table so no other file hard-codes a bare `1` or `'T'`.
 */

export const EVENT_TYPE = {
  DUTY_STATUS_CHANGE: 1,
  INTERMEDIATE_LOG: 2,
  PC_YM_INDICATION: 3,
  CERTIFICATION: 4,
  LOGIN_LOGOUT: 5,
  ENGINE_POWER: 6,
  MALFUNCTION_DIAGNOSTIC: 7,
} as const;

/** eventType 1 — duty status. */
export const DUTY_CODE = { OFF: 1, SB: 2, D: 3, ON: 4 } as const;

/** eventType 3 — Personal Conveyance / Yard Move indication. */
export const PC_YM_CODE = { CLEARED: 0, PC: 1, YM: 2 } as const;

/** eventType 5 — driver login/logout on the unit. */
export const LOGIN_CODE = { LOGIN: 1, LOGOUT: 2 } as const;

/** eventType 6 — engine power. */
export const POWER_CODE = { UP: 1, UP_REDUCED: 2, SHUTDOWN: 3, SHUTDOWN_REDUCED: 4 } as const;

/** eventType 7 — malfunction/diagnostic logged & cleared. */
export const MALFUNCTION_EVENT_CODE = {
  MALFUNCTION_LOGGED: 1,
  MALFUNCTION_CLEARED: 2,
  DIAGNOSTIC_LOGGED: 3,
  DIAGNOSTIC_CLEARED: 4,
} as const;

/** §5.5 / §7.8 — malfunction codes. */
export const MALFUNCTION = {
  POWER: 'P',
  ENGINE_SYNC: 'E',
  TIMING: 'T',
  POSITIONING: 'L',
  DATA_RECORDING: 'R',
  DATA_TRANSFER: 'S',
  OTHER: 'O',
} as const;
export type MalfunctionCode = (typeof MALFUNCTION)[keyof typeof MALFUNCTION];

/** §5.5 / §7.8 — diagnostic codes. */
export const DIAGNOSTIC = {
  POWER_DATA: '1',
  ENGINE_SYNC: '2',
  MISSING_DATA: '3',
  DATA_TRANSFER: '4',
  UNIDENTIFIED_DRIVING: '5',
  OTHER: '6',
} as const;
export type DiagnosticCode = (typeof DIAGNOSTIC)[keyof typeof DIAGNOSTIC];

/** §5.5 — `recordOrigin`. `2` means genuinely driver-entered and is NEVER set by ingest. */
export const RECORD_ORIGIN = {
  ELD_AUTOMATIC: 1,
  DRIVER_ENTERED: 2,
  OTHER_USER: 3,
  UNIDENTIFIED: 4,
} as const;

/** §5.5 — `recordStatus`. */
export const RECORD_STATUS = {
  ACTIVE: 1,
  INACTIVE_CHANGED: 2,
  CHANGE_REQUESTED: 3,
  CHANGE_REJECTED: 4,
} as const;

/** §5.5 — Appendix A sequence range: 1..65535, wrapping back to 1. */
export const EVENT_SEQUENCE_MIN = 1;
export const EVENT_SEQUENCE_MAX = 65535;

/** Next sequence number after `last`, wrapping 65535 → 1 (§5.5). */
export function nextSequenceId(last: number): number {
  if (!Number.isFinite(last) || last < EVENT_SEQUENCE_MIN || last >= EVENT_SEQUENCE_MAX) {
    return EVENT_SEQUENCE_MIN;
  }
  return Math.floor(last) + 1;
}

/** §7.8 — "speed ≥ 5 mph → D". */
export const DRIVING_SPEED_THRESHOLD_MPH = 5;
