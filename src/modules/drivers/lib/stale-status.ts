import type { DutyStatus } from '../../hos/hos.types';

/**
 * BUG-002 — web-only plausibility guard on the CURRENT duty status. The HOS engine counts the
 * open status up to `now`; when the ELD stops sending (BLE lost, app killed, tablet dead) a
 * driver can sit in DRIVING for days, and every clock reads 0 "limit exceeded". Past these
 * caps the fleet read stops accruing and flags the status as stale instead.
 *
 * - DRIVING 16 h: the longest window any driving can legally fall in is the 14-hour shift
 *   extended by the 2-hour adverse-conditions exception (§395.1(b)(1)); 11 h + 2 h adverse is
 *   the most driving inside it. An ELD that also records an intermediate log every hour of
 *   driving (§4.5.1.4) cannot plausibly leave one DRIVING record open for longer.
 * - ON_DUTY 24 h: a full calendar day of continuous on-duty-not-driving with no status change
 *   (no break, no sleeper, no logout) is not a real shift.
 * - OFF / SB: no cap — multi-day off-duty (home time, 34-hour restart) is normal.
 *
 * Shared engine code (`modules/hos/`, mirrored by the mobile Dart engine) is NOT touched: the
 * cap is applied by re-running the engine at the cap instant.
 */
export const MAX_PLAUSIBLE_STATUS_SEC: Readonly<Partial<Record<DutyStatus, number>>> = {
  D: 16 * 3600,
  ON: 24 * 3600,
};

/** Alert name raised once per stuck status (`alert.eld_*` ⇒ `NotificationKind.DEVICE`). */
export const HOS_STATUS_STALE_ALERT = 'alert.eld_status_stale';

/** The instant the current status stopped being plausible, or null while it still is. */
export function staleStatusCapAt(status: DutyStatus, statusSince: Date, now: Date): Date | null {
  const maxSec = MAX_PLAUSIBLE_STATUS_SEC[status];
  if (maxSec === undefined) return null;
  const capAt = new Date(statusSince.getTime() + maxSec * 1000);
  return now.getTime() > capAt.getTime() ? capAt : null;
}

/** BullMQ job id for the stale alert — one job per (driver, stuck status); no ':' (BullMQ v5). */
export function staleAlertJobId(driverId: string, statusSince: Date): string {
  return `hos-status-stale-${driverId}-${statusSince.getTime()}`;
}
