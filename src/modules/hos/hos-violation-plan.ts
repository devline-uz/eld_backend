/**
 * TZ §8.4 — the idempotent violation write rule, expressed as a PURE plan so the rule itself
 * is unit-testable without a database. `HosRecalcRepository` executes the plan; it decides
 * nothing.
 *
 *   1. every violation in the fresh result  → UPSERT on (driverId, logDate, type)
 *      (occurredAt / exceededBySec / detail refresh, `id` never changes)
 *   2. an OPEN row for that day that the fresh result no longer contains → AUTO_CLEARED
 *      (never deleted — the audit trail stays)
 *   3. a manually RESOLVED row is never reopened; only `exceededBySec` refreshes
 *
 * Without this, every recalculation inserts a new row and the "2 open violations" counter
 * inflates on each run.
 */
import type { Violation, ViolationType } from './hos.types';

export type ViolationRowStatus = 'OPEN' | 'RESOLVED' | 'AUTO_CLEARED';

export interface ExistingViolation {
  id: string;
  logDate: string;
  type: ViolationType;
  status: ViolationRowStatus;
  exceededBySec: number;
}

export type ViolationAction =
  | { kind: 'UPSERT'; logDate: string; type: ViolationType; occurredAt: Date; exceededBySec: number; detail: string; status: ViolationRowStatus }
  | { kind: 'REFRESH_RESOLVED'; id: string; logDate: string; type: ViolationType; exceededBySec: number }
  | { kind: 'AUTO_CLEAR'; id: string; logDate: string; type: ViolationType };

const key = (logDate: string, type: ViolationType): string => `${logDate}|${type}`;

/**
 * @param days   the RODS days that were recalculated — only rows inside this set may be
 *               auto-cleared, so a recalculation of one day never touches another day.
 */
export function reconcileViolations(fresh: Violation[], existing: ExistingViolation[], days: string[]): ViolationAction[] {
  const scope = new Set(days);
  const byKey = new Map<string, ExistingViolation>();
  for (const row of existing) byKey.set(key(row.logDate, row.type), row);

  const actions: ViolationAction[] = [];
  const seen = new Set<string>();

  for (const violation of fresh) {
    const k = key(violation.logDate, violation.type);
    seen.add(k);
    const row = byKey.get(k);
    if (row && row.status === 'RESOLVED') {
      // Rule 3 — a human closed this; recalculation may only refresh the magnitude.
      if (row.exceededBySec !== violation.exceededBySec) {
        actions.push({ kind: 'REFRESH_RESOLVED', id: row.id, logDate: violation.logDate, type: violation.type, exceededBySec: violation.exceededBySec });
      }
      continue;
    }
    actions.push({
      kind: 'UPSERT',
      logDate: violation.logDate,
      type: violation.type,
      occurredAt: violation.occurredAt,
      exceededBySec: violation.exceededBySec,
      detail: violation.detail,
      status: 'OPEN',
    });
  }

  for (const row of existing) {
    if (row.status !== 'OPEN') continue;
    if (!scope.has(row.logDate)) continue;
    if (seen.has(key(row.logDate, row.type))) continue;
    actions.push({ kind: 'AUTO_CLEAR', id: row.id, logDate: row.logDate, type: row.type });
  }

  return actions;
}
