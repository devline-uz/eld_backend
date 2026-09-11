/**
 * §8.3 step 5 — violation collection. One row per (logDate, type): that is exactly the
 * `HosViolation @@unique([driverId, logDate, type])` key the recalculation upserts on, so the
 * engine must never emit two violations of the same type on the same RODS day.
 */
import type { Violation, ViolationType } from '../hos.types';

export class ViolationCollector {
  private readonly byKey = new Map<string, Violation>();

  /**
   * Keeps the EARLIEST moment the limit was crossed and the LARGEST overrun of that day —
   * `occurredAt` answers "when did it start", `exceededBySec` answers "how bad did it get".
   */
  add(type: ViolationType, logDate: string, occurredAt: Date, exceededBySec: number, detail: string): void {
    const key = `${logDate}|${type}`;
    const existing = this.byKey.get(key);
    const rounded = Math.max(0, Math.round(exceededBySec));
    if (!existing) {
      this.byKey.set(key, { type, logDate, occurredAt, exceededBySec: rounded, detail });
      return;
    }
    if (occurredAt.getTime() < existing.occurredAt.getTime()) existing.occurredAt = occurredAt;
    if (rounded > existing.exceededBySec) {
      existing.exceededBySec = rounded;
      existing.detail = detail;
    }
  }

  list(): Violation[] {
    return [...this.byKey.values()].sort((a, b) => {
      const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
      return byTime !== 0 ? byTime : a.type.localeCompare(b.type);
    });
  }
}

export function formatHours(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
