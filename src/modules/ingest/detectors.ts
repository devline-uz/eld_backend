import { DIAGNOSTIC, DiagnosticCode, MALFUNCTION, MalfunctionCode } from './event-codes';

/**
 * TZ §7.8 — the backend-side automatic checks. Pure functions only: the repository gathers
 * the windows, the service turns a `DetectedCode` into an eventType 7 record + an alert.
 *
 * Thresholds are normative (§7.8 table) and the timing one is the SAME 10 minutes as §7.3
 * rule 5 — the two sections previously disagreed (5 vs 10) and 10 is the FMCSA figure.
 */

/** §7.3 rule 5 + §7.8 `T` — a single threshold, used in both places. */
export const CLOCK_DRIFT_LIMIT_SEC = 10 * 60;
/** §7.8 `P` / `E` / `5` — 30 minutes accumulated inside a rolling 24 hours. */
export const THIRTY_MIN_SEC = 30 * 60;
/** §7.8 `L` — 60 minutes with no valid position. */
export const POSITIONING_LIMIT_SEC = 60 * 60;
/** §7.8 `S` — three consecutive failed transfers. */
export const DATA_TRANSFER_FAILURE_LIMIT = 3;
/** §7.7 — device backlog alert threshold. */
export const DEVICE_BACKLOG_LIMIT = 100;
/** §7.6 — no BLE connection for this long raises `alert.eld_disconnected`. */
export const BLE_DISCONNECTED_ALERT_SEC = 30 * 60;
/** The rolling window every "in 24 hours" rule in §7.8 is measured over. */
export const AUTO_CHECK_WINDOW_SEC = 24 * 60 * 60;

export interface DetectedCode {
  kind: 'malfunction' | 'diagnostic';
  code: MalfunctionCode | DiagnosticCode;
  /** Human-readable justification; stored on the eventType 7 record's annotation. */
  reason: string;
}

const malfunction = (code: MalfunctionCode, reason: string): DetectedCode => ({
  kind: 'malfunction',
  code,
  reason,
});
const diagnostic = (code: DiagnosticCode, reason: string): DetectedCode => ({
  kind: 'diagnostic',
  code,
  reason,
});

// ---------------------------------------------------------------------------
// Per-event checks (run inside the ingest transaction, on the event itself)
// ---------------------------------------------------------------------------

/** §7.3 rule 5 — drift is measured against server UTC and PERSISTED whether or not it trips. */
export function clockDriftSec(eventDateTime: Date, serverNow: Date): number {
  return Math.round((eventDateTime.getTime() - serverNow.getTime()) / 1000);
}

/** §7.8 `T` — |drift| strictly greater than 10 minutes. */
export function isTimingMalfunction(driftSec: number): boolean {
  return Math.abs(driftSec) > CLOCK_DRIFT_LIMIT_SEC;
}

export interface MissingDataInput {
  checksumOk: boolean;
  /** Mandatory §395 fields that the payload did not carry. */
  missingFields: readonly string[];
  /** §4.3 — device odometer went backwards or jumped > 2000 mi/day. */
  odometerAnomaly: boolean;
}

/** §7.8 diagnostic `3` — "checksum wrong or a mandatory field missing" (+ §4.3 odometer). */
export function detectMissingData(input: MissingDataInput): DetectedCode | null {
  const reasons: string[] = [];
  if (!input.checksumOk) reasons.push('checksum');
  if (input.missingFields.length) reasons.push(`missing: ${input.missingFields.join(',')}`);
  if (input.odometerAnomaly) reasons.push('odometer anomaly');
  return reasons.length ? diagnostic(DIAGNOSTIC.MISSING_DATA, reasons.join('; ')) : null;
}

// ---------------------------------------------------------------------------
// Windowed checks (run after the batch commits, over the last 24 hours)
// ---------------------------------------------------------------------------

export interface AutoCheckWindow {
  /** Seconds of engine-power interruption accumulated in the window (§7.8 `P`). */
  powerOffSec: number;
  /** Longest / accumulated stretch with no ECM data while the engine ran (§7.8 `E`). */
  ecmSilenceSec: number;
  /** Accumulated time with no valid geo position (§7.8 `L`). */
  noPositionSec: number;
  /** Unidentified driving accumulated in the window (§7.8 diagnostic `5`). */
  unidentifiedDrivingSec: number;
  /** Consecutive failed data transfers (§7.8 `S`). */
  consecutiveTransferFailures: number;
  /** Events still waiting in device memory (§7.7 / §7.8 `R`). */
  storedEventsCount: number;
  /** True when the device reported that records were dropped (§7.8 `R`). */
  recordsLost: boolean;
  /** True when any event in the window failed its checksum (§7.8 diagnostic `3` / `1`). */
  powerDataMissing: boolean;
}

/**
 * §7.8 — the full table, minus `T` and `3`, which are per-event and evaluated above.
 * Returns every condition that currently holds; the caller de-duplicates against codes already
 * logged in the window so a malfunction is not re-recorded on every batch.
 */
export function runWindowChecks(w: AutoCheckWindow): DetectedCode[] {
  const found: DetectedCode[] = [];

  if (w.powerOffSec >= THIRTY_MIN_SEC) {
    found.push(malfunction(MALFUNCTION.POWER, `power off ${w.powerOffSec}s in 24h`));
  }
  if (w.powerDataMissing) {
    found.push(diagnostic(DIAGNOSTIC.POWER_DATA, 'power data missing from engine power events'));
  }
  if (w.ecmSilenceSec >= THIRTY_MIN_SEC) {
    found.push(malfunction(MALFUNCTION.ENGINE_SYNC, `no ECM data ${w.ecmSilenceSec}s in 24h`));
    found.push(diagnostic(DIAGNOSTIC.ENGINE_SYNC, 'engine synchronization data incomplete'));
  }
  if (w.noPositionSec >= POSITIONING_LIMIT_SEC) {
    found.push(malfunction(MALFUNCTION.POSITIONING, `no position for ${w.noPositionSec}s`));
  }
  if (w.recordsLost || w.storedEventsCount >= DEVICE_BACKLOG_LIMIT) {
    found.push(
      malfunction(
        MALFUNCTION.DATA_RECORDING,
        w.recordsLost
          ? 'device reported lost records'
          : `device memory backlog ${w.storedEventsCount} events`,
      ),
    );
  }
  if (w.consecutiveTransferFailures >= DATA_TRANSFER_FAILURE_LIMIT) {
    found.push(
      malfunction(
        MALFUNCTION.DATA_TRANSFER,
        `${w.consecutiveTransferFailures} consecutive transfer failures`,
      ),
    );
    found.push(diagnostic(DIAGNOSTIC.DATA_TRANSFER, 'data transfer compliance degraded'));
  }
  if (w.unidentifiedDrivingSec >= THIRTY_MIN_SEC) {
    found.push(
      diagnostic(
        DIAGNOSTIC.UNIDENTIFIED_DRIVING,
        `${w.unidentifiedDrivingSec}s unidentified driving in 24h`,
      ),
    );
  }
  return found;
}

/** §7.6 — over 30 minutes without a CONNECTED BLE link raises `alert.eld_disconnected`. */
export function isBleDisconnectedTooLong(
  state: 'CONNECTED' | 'OUT_OF_RANGE' | 'DISCONNECTED',
  lastSeenAt: Date | null,
  now: Date,
): boolean {
  if (state === 'CONNECTED') return false;
  if (!lastSeenAt) return true;
  return (now.getTime() - lastSeenAt.getTime()) / 1000 > BLE_DISCONNECTED_ALERT_SEC;
}

/** §7.7 — more than 100 events waiting on the device raises `alert.device_backlog`. */
export function isDeviceBacklog(storedEventsCount: number): boolean {
  return storedEventsCount > DEVICE_BACKLOG_LIMIT;
}
