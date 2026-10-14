/**
 * LIVE-001 / CODE-006 / CODE-007 — the pure half of `scripts/hos-recalc-backfill.ts`.
 *
 * The script never writes HOS data itself: it only decides WHICH `hos.recalc` jobs to queue
 * (`{ driverId, fromDate }`), and the running worker executes them through the normal
 * `HosRecalcService.recalculate` — the same idempotent path every log change uses (upsert on
 * (driverId, logDate, type); stale OPEN rows AUTO_CLEARED with an audit entry, never deleted;
 * RESOLVED rows never reopened; certification never touched).
 */
import { activeRecords, type SupersedeAware } from '../logs/rods';

export interface BackfillArgs {
  /** false (default) = dry run: print the plan, queue nothing. */
  apply: boolean;
  /** Only these drivers (repeatable `--driver <id>`); empty = every driver with an OPEN row. */
  driverIds: string[];
  /** `--from YYYY-MM-DD` — recalculate from this RODS day at the latest (CODE-006 edits). */
  from: string | null;
  /** `--all-drivers` (needs `--from`) — every non-deleted driver, not only those with OPEN rows. */
  allDrivers: boolean;
  /** `--unidentified-report` — list CODE-007 assignments that need a reject + re-assign. */
  unidentifiedReport: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const args: BackfillArgs = { apply: false, driverIds: [], from: null, allDrivers: false, unidentifiedReport: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.split('=', 2) as [string, string | undefined];
    const value = (): string => {
      const v = inline ?? argv[(i += 1)];
      if (!v) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--apply':
        args.apply = true;
        break;
      case '--dry-run':
        args.apply = false;
        break;
      case '--driver':
        args.driverIds.push(value());
        break;
      case '--from': {
        const v = value();
        if (!DATE.test(v)) throw new Error(`--from expects YYYY-MM-DD, got "${v}"`);
        args.from = v;
        break;
      }
      case '--all-drivers':
        args.allDrivers = true;
        break;
      case '--unidentified-report':
        args.unidentifiedReport = true;
        break;
      default:
        throw new Error(`Unknown argument "${arg}"`);
    }
  }
  if (args.allDrivers && !args.from) throw new Error('--all-drivers needs --from YYYY-MM-DD (a bounded recalculation)');
  return args;
}

export interface OpenViolationSummary {
  driverId: string;
  /** Earliest OPEN `HosViolation.logDate`, "YYYY-MM-DD". */
  earliestOpen: string;
  openCount: number;
}

export interface BackfillJob {
  driverId: string;
  fromDate: string;
  openCount: number;
}

/**
 * One job per driver, from the EARLIEST day that must be re-evaluated: the driver's earliest
 * OPEN violation (so an orphan is inside the recalculated range and can be cleared) or `from`,
 * whichever is older. Never later than `today` (the service clamps as well).
 */
export function planBackfillJobs(
  open: OpenViolationSummary[],
  opts: { from: string | null; allDriverIds?: string[]; driverIds?: string[]; today: string },
): BackfillJob[] {
  const wanted = opts.driverIds && opts.driverIds.length ? new Set(opts.driverIds) : null;
  const byDriver = new Map<string, BackfillJob>();
  const add = (driverId: string, fromDate: string, openCount: number): void => {
    if (wanted && !wanted.has(driverId)) return;
    const clamped = fromDate > opts.today ? opts.today : fromDate;
    const prev = byDriver.get(driverId);
    if (!prev) byDriver.set(driverId, { driverId, fromDate: clamped, openCount });
    else byDriver.set(driverId, { driverId, fromDate: clamped < prev.fromDate ? clamped : prev.fromDate, openCount: prev.openCount + openCount });
  };
  for (const row of open) add(row.driverId, opts.from && opts.from < row.earliestOpen ? opts.from : row.earliestOpen, row.openCount);
  if (opts.from) for (const id of opts.allDriverIds ?? []) add(id, opts.from, 0);
  if (opts.from && wanted) for (const id of wanted) add(id, opts.from, 0);
  return [...byDriver.values()].sort((a, b) => a.fromDate.localeCompare(b.fromDate) || a.driverId.localeCompare(b.driverId));
}

/**
 * CODE-007 — an assignment made before the fix whose segment was never closed on the driver's
 * log: no ACTIVE duty-status record of the driver sits exactly at the segment end, so the
 * segment's last status ran on until the driver's next own record. `recordsAtEnd` are the
 * driver's records (every status) at `endAt`.
 */
export function isUnclosedAssignment(
  recordsAtEnd: Array<SupersedeAware & { eventType: number }>,
): boolean {
  return !activeRecords(recordsAtEnd).some((record) => record.eventType === 1);
}
