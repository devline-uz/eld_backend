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
import { inclusiveDayCount } from './filename';

/** §10.3 — the RODS range an inspector may ask for: today plus the previous 7 days. */
export const MAX_TRANSFER_RANGE_DAYS = 8;

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
  rangeStart: Date;
  rangeEnd: Date;
  /** Unidentified segments touching the range that are still PENDING. */
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
