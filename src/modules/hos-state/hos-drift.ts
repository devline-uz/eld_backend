import type { DutyStatus, HosState, ViolationType } from '../hos/hos.types';

/**
 * TZ §8.6 point 5 — drift comparison between the SERVER's HOS state and the state the mobile
 * (Dart) engine computed offline. Pure: no DB, no Nest, no clock. The server is the source of
 * truth; this file only measures how far the app is from it.
 */

/** §8.6 — a difference above this many seconds is drift, not rounding. */
export const HOS_DRIFT_THRESHOLD_SEC = 60;

/** The state the app posts (a subset of `HosState` — the app never sends internal timestamps). */
export interface MobileHosState {
  currentStatus: DutyStatus;
  driveRemainingSec: number;
  shiftRemainingSec: number;
  breakRemainingSec: number;
  cycleRemainingSec: number;
  dailyTotals: { off: number; sb: number; drive: number; on: number };
  violations: Array<{ type: ViolationType; exceededBySec: number }>;
  /**
   * MR-24 — optional engine timestamps (ISO-8601 or null). The app MAY post them; they are
   * stored with the snapshot but never compared (the counters above already carry the drift).
   */
  statusSince?: string | null;
  nextBreakDueAt?: string | null;
  shiftEndsAt?: string | null;
  cycleRecapAt?: string | null;
  restartAvailableAt?: string | null;
}

/**
 * MR-24 — what the server SENDS (hos-state `serverState`, bootstrap `hos.state`): the mobile
 * shape plus the engine's own timestamps, so the home timer no longer derives them locally.
 */
export interface ServerHosState extends MobileHosState {
  /** When the current duty status started. */
  statusSince: string;
  /** When the 30-minute break is due: set while driving (or already overdue), else null. */
  nextBreakDueAt: string | null;
  /** When the 14-hour window ends; null when no shift is open. */
  shiftEndsAt: string | null;
  /** End of today (home-terminal zone) when the oldest recap day carries on-duty hours that drop off; else null. */
  cycleRecapAt: string | null;
  /** While OFF/SB: when the current rest reaches 34 h (restart); null while ON/D. */
  restartAvailableAt: string | null;
}

export interface DriftField {
  field: string;
  serverSec: number;
  appSec: number;
  diffSec: number;
}

export interface DriftComparison {
  /** Largest absolute per-field difference, in seconds. */
  maxDriftSec: number;
  /** Only the fields that differ at all, worst first. */
  fields: DriftField[];
  /** The two engines disagree about the CURRENT duty status — always drift, whatever the seconds say. */
  statusMismatch: boolean;
  serverStatus: DutyStatus;
  appStatus: DutyStatus;
  /** True when this comparison must raise `alert.hos_engine_drift`. */
  drift: boolean;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/** Server-side counters, flattened to the same shape the app posts, plus the MR-24 timestamps. */
export function toMobileShape(state: HosState): ServerHosState {
  return {
    currentStatus: state.currentStatus,
    driveRemainingSec: state.driveRemainingSec,
    shiftRemainingSec: state.shiftRemainingSec,
    breakRemainingSec: state.breakRemainingSec,
    cycleRemainingSec: state.cycleRemainingSec,
    dailyTotals: { ...state.dailyTotals },
    violations: worstPerType(state.violations).map(([type, exceededBySec]) => ({ type, exceededBySec })),
    statusSince: state.statusSince.toISOString(),
    nextBreakDueAt: iso(state.nextBreakDueAt),
    shiftEndsAt: iso(state.shiftEndsAt),
    cycleRecapAt: iso(state.cycleRecapAt),
    restartAvailableAt: iso(state.restartAvailableAt),
  };
}

/**
 * One violation entry per type, keeping the largest `exceededBySec`. The server state can carry
 * several days of the same violation type; the app posts a flat list. Comparing the worst of each
 * type is the only mapping that is symmetric in both directions.
 */
function worstPerType(
  violations: Array<{ type: ViolationType; exceededBySec: number }>,
): Array<[ViolationType, number]> {
  const worst = new Map<ViolationType, number>();
  for (const violation of violations) {
    const current = worst.get(violation.type) ?? 0;
    if (violation.exceededBySec > current) worst.set(violation.type, violation.exceededBySec);
  }
  return [...worst.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * Compares the server's state with the app's.
 *
 * Drift is raised when the worst per-field difference exceeds §8.6's 60 s threshold, or when the
 * two engines disagree about the current duty status (a status disagreement means every counter
 * below it is being accumulated against a different bucket, so it is drift at 0 seconds).
 *
 * A violation the server found and the app did not (or the reverse) is measured as the full
 * `exceededBySec`, so a missed 11-hour violation drifts by its whole magnitude.
 */
export function compareHosState(server: HosState, app: MobileHosState): DriftComparison {
  const serverShape = toMobileShape(server);
  const fields: DriftField[] = [];

  const push = (field: string, serverSec: number, appSec: number): void => {
    const diffSec = Math.abs(Math.round(serverSec) - Math.round(appSec));
    if (diffSec > 0) fields.push({ field, serverSec, appSec, diffSec });
  };

  push('driveRemainingSec', serverShape.driveRemainingSec, app.driveRemainingSec);
  push('shiftRemainingSec', serverShape.shiftRemainingSec, app.shiftRemainingSec);
  push('breakRemainingSec', serverShape.breakRemainingSec, app.breakRemainingSec);
  push('cycleRemainingSec', serverShape.cycleRemainingSec, app.cycleRemainingSec);
  push('dailyTotals.off', serverShape.dailyTotals.off, app.dailyTotals.off);
  push('dailyTotals.sb', serverShape.dailyTotals.sb, app.dailyTotals.sb);
  push('dailyTotals.drive', serverShape.dailyTotals.drive, app.dailyTotals.drive);
  push('dailyTotals.on', serverShape.dailyTotals.on, app.dailyTotals.on);

  const appWorst = new Map(worstPerType(app.violations));
  const serverWorst = new Map(worstPerType(serverShape.violations));
  const types = [...new Set([...serverWorst.keys(), ...appWorst.keys()])].sort();
  for (const type of types) {
    push(`violation.${type}`, serverWorst.get(type) ?? 0, appWorst.get(type) ?? 0);
  }

  fields.sort((a, b) => b.diffSec - a.diffSec);
  const maxDriftSec = fields.length ? fields[0].diffSec : 0;
  const statusMismatch = serverShape.currentStatus !== app.currentStatus;

  return {
    maxDriftSec,
    fields,
    statusMismatch,
    serverStatus: serverShape.currentStatus,
    appStatus: app.currentStatus,
    drift: statusMismatch || maxDriftSec > HOS_DRIFT_THRESHOLD_SEC,
  };
}
