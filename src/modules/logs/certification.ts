/**
 * TZ §9.2 / §395.22(i) — driver certification of a RODS day.
 *
 * Appendix A gives the certification record (`eventType = 4`) only ONE digit of event code:
 * `1` for the first certification of a day and `2..9` for re-certifications, so the ninth and
 * every later re-certification are all reported as `9`. The true number lives on
 * `DailyLog.certificationCount`, which is not bounded by the file format.
 */
export const CERTIFICATION_EVENT_TYPE = 4;
export const CERTIFICATION_EVENT_CODE_MAX = 9;

/**
 * `priorCount` is `DailyLog.certificationCount` BEFORE this certification.
 *   0 → 1 (first), 1 → 2, ... 8 → 9, 9+ → 9 (saturates, Appendix A limit).
 */
export function certificationEventCode(priorCount: number): number {
  if (!Number.isFinite(priorCount) || priorCount <= 0) return 1;
  return Math.min(Math.floor(priorCount) + 1, CERTIFICATION_EVENT_CODE_MAX);
}

/**
 * TZ §9.2 / §14 — `alert.uncertified_logs` fires at 8 days, everywhere. The §14 seed table
 * said 3 days in an earlier revision; that was corrected to 8 in both places.
 */
export const UNCERTIFIED_LOGS_ALERT_DAYS = 8;

/** RODS days older than the window that are still uncertified (§395.22(i), 13-day limit). */
export function uncertifiedAlertDue(uncertifiedDays: string[], todayKey: string, thresholdDays = UNCERTIFIED_LOGS_ALERT_DAYS): boolean {
  return uncertifiedDays.some((day) => daysBetween(day, todayKey) >= thresholdDays);
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}
