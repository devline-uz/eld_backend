/**
 * LIVE-027 — the web rule editor offers a product vocabulary (`hos.violation`, `safety.harsh`,
 * `geofence.exit` …, `eld_web/src/features/settings/lib/alertConditions.ts`) while the workers
 * enqueue `alert.*` job names. `AlertProcessor` matched rules on the job name only, so every rule
 * built in Settings › Alert rules silently never fired. A job now matches its own name AND the
 * editor event(s) it stands for. Pure, so the mapping is unit-tested on its own.
 */
type Alias = { event: string; when?: (payload: Record<string, unknown>) => boolean };

const ALIASES: Record<string, Alias[]> = {
  'alert.hos_violation': [{ event: 'hos.violation' }],
  'alert.harsh_event': [{ event: 'safety.harsh' }],
  'alert.geofence_exit': [{ event: 'geofence.exit' }],
  'alert.eld_disconnected': [{ event: 'device.offline' }],
  'alert.unidentified_driving': [{ event: 'unidentified.created' }],
  // `maintenance-due.processor` raises one job for DUE_SOON and OVERDUE; the editor rule is "overdue".
  'alert.maintenance_due': [{ event: 'maintenance.overdue', when: (p) => p.state === 'OVERDUE' }],
};

/** Every `conditions[].event` value that a job named `jobName` (with `payload`) satisfies. */
export function ruleEventsFor(jobName: string, payload: Record<string, unknown> = {}): string[] {
  const out = [jobName];
  const breakDue: Alias[] = jobName.startsWith('alert.break_') ? [{ event: 'hos.break_due' }] : [];
  for (const alias of [...(ALIASES[jobName] ?? []), ...breakDue]) {
    if (!alias.when || alias.when(payload)) out.push(alias.event);
  }
  return out;
}

/**
 * `hos-recalc` re-reads a still-driving driver every 5 minutes (`hos-open-driving` sweep) and
 * raises `alert.break_due` once per 5-minute step of the countdown. A rule "break due within M
 * minutes" matches every step at or under M (BE-12 — the recalc samples are not guaranteed to land
 * inside one 5-minute window, so matching only the step that crosses M could skip the alert), and
 * `AlertProcessor` delivers it once per break ({@link breakDueEpisode}), not every sweep.
 */
export const BREAK_DUE_STEP_MIN = 5;
/** The editor rule without `params.minutes` (and the system default) means "within 30 minutes". */
export const BREAK_DUE_DEFAULT_MIN = 30;

/**
 * BE-12 — the break a `alert.break_*` job is about: (driver, break deadline). `AlertProcessor`
 * delivers a rule to a recipient once per episode, whichever step crossed the threshold first.
 * Null for any other job, or a payload without both keys (nothing to dedupe on).
 */
export function breakDueEpisode(jobName: string, payload: Record<string, unknown>): { driverId: string; nextBreakDueAt: string } | null {
  if (!jobName.startsWith('alert.break_')) return null;
  const { driverId, nextBreakDueAt } = payload;
  return typeof driverId === 'string' && typeof nextBreakDueAt === 'string' ? { driverId, nextBreakDueAt } : null;
}

export interface RuleCondition {
  event: string;
  params?: { minutes?: unknown } | null;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The editor's `params.minutes` thresholds (`alertConditions.ts` — "within / for / longer than (minutes)")
 * used to be stored and never read. Evaluated against the job payload; a payload that does not
 * carry the measured value still matches (older producers, nothing to compare against).
 */
export function conditionParamsMatch(condition: RuleCondition, payload: Record<string, unknown>, now: Date = new Date()): boolean {
  const minutes = num(condition.params?.minutes);
  if (condition.event === 'hos.break_due') {
    const left = num(payload.minutesUntilBreak);
    if (left === undefined) return true;
    const threshold = minutes ?? BREAK_DUE_DEFAULT_MIN;
    return left <= threshold;
  }
  if (minutes === undefined) return true;
  if (condition.event === 'device.offline') {
    const lastSeen = typeof payload.lastSeenAt === 'string' || payload.lastSeenAt instanceof Date ? new Date(payload.lastSeenAt) : undefined;
    if (!lastSeen || Number.isNaN(lastSeen.getTime())) return true;
    return (now.getTime() - lastSeen.getTime()) / 60_000 >= minutes;
  }
  if (condition.event === 'unidentified.created') {
    const durationSec = num(payload.durationSec);
    return durationSec === undefined ? true : durationSec / 60 > minutes;
  }
  return true;
}
