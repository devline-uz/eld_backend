/**
 * Pre-send validation — tz.md §10.3.
 *
 * | check                         | code                      | level   |
 * |-------------------------------|---------------------------|---------|
 * | unresolved unidentified       | UNRESOLVED_UNIDENTIFIED   | warning |
 * | uncertified day in range      | UNCERTIFIED_LOGS          | warning |
 * | active malfunction            | ACTIVE_MALFUNCTION        | warning |
 * | eRODS TEST mode               | ERODS_TEST_MODE           | warning |
 * | driver not found              | DRIVER_NOT_FOUND          | error   |
 * | range wider than 8 days       | RANGE_TOO_LARGE           | error   |
 *
 * Warnings NEVER block: §395.24 requires the driver to be able to produce the file at
 * roadside even when the log set is imperfect. Errors block, because the resulting file
 * would be meaningless or non-conformant.
 */
import { dayEnd, dayKey, dayStart } from '../hos/engine/timezone';
import { inclusiveDayCount } from './filename';

/**
 * §10.3 — the RODS range an inspector may ask for: today plus the previous 7 days. Counted in
 * RODS days of the driver's home-terminal timezone (§395.2 "24-hour period" starting at the
 * home-terminal midnight), never in UTC calendar days (B-172).
 */
export const MAX_TRANSFER_RANGE_DAYS = 8;

/** A transfer range bound: a RODS day key `YYYY-MM-DD` (taken as-is) or an instant. */
export type TransferRangeBound = string | Date;

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The request range resolved to home-terminal RODS days (B-172, D-156). */
export interface ResolvedTransferRange {
  /** First / last RODS day key in the home-terminal timezone. */
  startKey: string;
  endKey: string;
  /** The day keys as UTC-midnight dates — the `@db.Date` form of `DataTransfer.rangeStart/End` and `DailyLog.logDate`. */
  rangeStart: Date;
  rangeEnd: Date;
  /** Real instants: home-terminal midnight that opens `startKey` / closes `endKey` (DST-safe, 23/25 h days). */
  fromInstant: Date;
  toInstant: Date;
}

/**
 * B-172 — maps a request range onto home-terminal RODS days. A `YYYY-MM-DD` bound is already a
 * RODS day; an instant is converted to the RODS day it falls on in `timezone`. Shared by the
 * back-office and the driver route (both go through `TransfersService.create`).
 */
export function resolveTransferRange(
  timezone: string,
  start: TransferRangeBound,
  end: TransferRangeBound,
): ResolvedTransferRange {
  const startKey = boundDayKey(timezone, start);
  const endKey = boundDayKey(timezone, end);
  return {
    startKey,
    endKey,
    rangeStart: new Date(`${startKey}T00:00:00.000Z`),
    rangeEnd: new Date(`${endKey}T00:00:00.000Z`),
    fromInstant: dayStart(timezone, startKey),
    toInstant: dayEnd(timezone, endKey),
  };
}

function boundDayKey(timezone: string, bound: TransferRangeBound): string {
  if (typeof bound === 'string' && DAY_KEY_RE.test(bound)) return bound;
  return dayKey(timezone, bound instanceof Date ? bound : new Date(bound));
}

export type PreSendLevel = 'warning' | 'error';

export interface PreSendFinding {
  code:
    | 'UNRESOLVED_UNIDENTIFIED'
    | 'UNCERTIFIED_LOGS'
    | 'ACTIVE_MALFUNCTION'
    | 'ERODS_TEST_MODE'
    | 'DRIVER_NOT_FOUND'
    | 'RANGE_TOO_LARGE';
  level: PreSendLevel;
  message: string;
  details?: Record<string, unknown>;
}

export interface PreSendContext {
  driverExists: boolean;
  /** RODS day keys as UTC-midnight dates (`ResolvedTransferRange.rangeStart/End`), so a UTC day count is a home-terminal day count. */
  rangeStart: Date;
  rangeEnd: Date;
  /** Unidentified segments touching the range that are still unresolved (PENDING / PENDING_CONFIRMATION). */
  unresolvedUnidentifiedCount: number;
  /** Days in the range whose `DailyLog.certified` is false. */
  uncertifiedDayCount: number;
  /** Malfunctions logged (eventType 7, code 1) with no matching clear (code 2). */
  activeMalfunctionCodes: string[];
  erodsMode: 'TEST' | 'PRODUCTION';
}

export interface PreSendResult {
  findings: PreSendFinding[];
  errors: PreSendFinding[];
  warnings: PreSendFinding[];
  /** True when nothing blocks generation. */
  canGenerate: boolean;
}

export function runPreSendChecks(ctx: PreSendContext): PreSendResult {
  const findings: PreSendFinding[] = [];

  if (!ctx.driverExists) {
    findings.push({ code: 'DRIVER_NOT_FOUND', level: 'error', message: 'Driver does not exist.' });
  }

  const days = inclusiveDayCount(ctx.rangeStart, ctx.rangeEnd);
  if (ctx.rangeEnd.getTime() < ctx.rangeStart.getTime()) {
    findings.push({
      code: 'RANGE_TOO_LARGE',
      level: 'error',
      message: 'Range end is before range start.',
      details: { rangeStart: ctx.rangeStart, rangeEnd: ctx.rangeEnd },
    });
  } else if (days > MAX_TRANSFER_RANGE_DAYS) {
    findings.push({
      code: 'RANGE_TOO_LARGE',
      level: 'error',
      message: `Requested range is ${days} days; §395.24 / Appendix A allows at most ${MAX_TRANSFER_RANGE_DAYS}.`,
      details: { days, max: MAX_TRANSFER_RANGE_DAYS },
    });
  }

  if (ctx.unresolvedUnidentifiedCount > 0) {
    findings.push({
      code: 'UNRESOLVED_UNIDENTIFIED',
      level: 'warning',
      message: `${ctx.unresolvedUnidentifiedCount} unidentified driving segment(s) in the range are still unresolved.`,
      details: { count: ctx.unresolvedUnidentifiedCount },
    });
  }

  if (ctx.uncertifiedDayCount > 0) {
    findings.push({
      code: 'UNCERTIFIED_LOGS',
      level: 'warning',
      message: `${ctx.uncertifiedDayCount} day(s) in the range are not certified by the driver.`,
      details: { count: ctx.uncertifiedDayCount },
    });
  }

  if (ctx.activeMalfunctionCodes.length > 0) {
    findings.push({
      code: 'ACTIVE_MALFUNCTION',
      level: 'warning',
      message: `Active ELD malfunction(s): ${ctx.activeMalfunctionCodes.join(', ')}.`,
      details: { codes: ctx.activeMalfunctionCodes },
    });
  }

  if (ctx.erodsMode === 'TEST') {
    findings.push({
      code: 'ERODS_TEST_MODE',
      level: 'warning',
      message: 'eRODS is in TEST mode — the file is generated and downloadable but not sent to FMCSA.',
    });
  }

  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warning');
  return { findings, errors, warnings, canGenerate: errors.length === 0 };
}
