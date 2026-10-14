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
