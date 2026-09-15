/**
 * OneBook ELD — pure helpers for the safety-comms mock generator, split out from
 * generators/safety-comms.ts purely so the non-trivial logic (risk distribution, score
 * derivation feed, coaching-status aging, message-template selection) can be unit tested
 * without touching Prisma. See prisma/mock/generators/safety-comms.spec-manual.ts for the
 * standalone runner (jest's `testMatch` only covers `src/**`, not `prisma/mock/**`).
 */

/**
 * Long-tail risk factor in (0, 1) — most drivers land low, a shrinking few land high. Cubing a
 * uniform draw pushes the mass toward 0 while still reaching 1, which is exactly a "few very
 * risky drivers, most drivers fine" shape without pulling in a full stats dependency.
 */
export function riskFactor(uniform01: number): number {
  if (uniform01 < 0 || uniform01 >= 1) throw new Error('riskFactor: uniform01 must be in [0, 1)');
  return Math.pow(uniform01, 3);
}

export interface MonthlyEventRates {
  harshPerMonth: number;
  speedingPerMonth: number;
  seatbeltPerMonth: number;
}

/** Base + risk-scaled monthly event rates per driver, per safety-event family. */
export function ratesForRisk(risk: number): MonthlyEventRates {
  return {
    harshPerMonth: 2 + risk * 40,
    speedingPerMonth: 1 + risk * 25,
    seatbeltPerMonth: risk * 3,
  };
}

/**
 * Coaching-status distribution buckets by event age (§tasks.md "recent NEW events" +
 * "long tail of risky drivers" both need age-correlated statuses: a fresh event has not been
 * triaged yet, an old one has almost certainly been resolved one way or another).
 */
export type CoachingStatusName = 'NEW' | 'REVIEWED' | 'COACHED' | 'DISMISSED';

export function statusWeightsForAgeDays(ageDays: number): Record<CoachingStatusName, number> {
  if (ageDays <= 3) return { NEW: 0.85, REVIEWED: 0.1, COACHED: 0.03, DISMISSED: 0.02 };
  if (ageDays <= 14) return { NEW: 0.5, REVIEWED: 0.2, COACHED: 0.15, DISMISSED: 0.15 };
  return { NEW: 0.1, REVIEWED: 0.25, COACHED: 0.35, DISMISSED: 0.3 };
}

/** Picks a status name from `pick01` (a uniform [0,1) draw) against the weight table above. */
export function pickStatus(weights: Record<CoachingStatusName, number>, pick01: number): CoachingStatusName {
  const entries = Object.entries(weights) as Array<[CoachingStatusName, number]>;
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let target = pick01 * total;
  for (const [name, w] of entries) {
    target -= w;
    if (target <= 0) return name;
  }
  return entries[entries.length - 1][0];
}

/** Proxy severity 1-5 from how far a measured delta went past its trigger threshold. */
export function severityFromDelta(delta: number, threshold: number): number {
  const ratio = delta / threshold;
  return Math.max(1, Math.min(5, Math.round(ratio * 2)));
}

/** True average miles/day for a driver active window, guarding against a zero/negative span. */
export function activeDaysFraction(activeDays: number, totalDaysInPeriod: number): number {
  if (totalDaysInPeriod <= 0) return 0;
  return Math.max(0, Math.min(1, activeDays / totalDaysInPeriod));
}
