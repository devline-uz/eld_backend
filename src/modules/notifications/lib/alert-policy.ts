import { DateTime } from 'luxon';

/**
 * TZ §14 — deterministic alert-delivery policy: throttle (`perDriverPerDay`), cooldown
 * (`cooldownMin`) and quiet hours. Pure functions only, so the boundary behaviour is
 * unit-testable without Redis/Postgres/BullMQ (see alert-policy.spec.ts).
 *
 * All three checks are evaluated against the SUBJECT's local time zone (driver's
 * `homeTerminalTimezone`, or the carrier's `timezone` when the alert has no driver
 * subject) — never the server's local time, since the worker container can run in any
 * region/UTC configuration.
 */

export interface ThrottleConfig {
  /** Max deliveries to the same recipient+rule combination per calendar day (subject tz). */
  perDriverPerDay?: number;
  /** Minimum minutes between two deliveries of the same rule to the same recipient. */
  cooldownMin?: number;
}

export interface QuietHoursConfig {
  /** "HH:mm" 24h, subject-local. */
  from: string;
  /** "HH:mm" 24h, subject-local. */
  to: string;
  /** IANA zone id. Present for documentation/back-compat; callers pass the resolved zone
   *  separately since the *actual* zone must be the subject's, not necessarily this one. */
  timezone: string;
}

export interface AlertPolicyInput {
  now: Date;
  /** IANA timezone of the alert's subject (driver/carrier), e.g. "America/Chicago". */
  zone: string;
  throttle?: ThrottleConfig | null;
  quietHours?: QuietHoursConfig | null;
  /** Deliveries already SENT today (subject-local calendar day) for this rule+recipient. */
  deliveriesTodayCount: number;
  /** When the last delivery of this rule+recipient was sent, if any. */
  lastDeliveredAt?: Date | null;
  /** CRITICAL severity bypasses quiet hours (§14 — a violation must reach the driver). */
  bypassQuietHours?: boolean;
}

export type AlertSuppressReason = 'THROTTLED' | 'COOLDOWN' | 'QUIET_HOURS';

export interface AlertPolicyDecision {
  allowed: boolean;
  reason?: AlertSuppressReason;
}

/** True when `now` (in `zone`) falls inside the [from, to) quiet-hours window, wrapping midnight. */
export function isWithinQuietHours(now: Date, zone: string, quietHours: QuietHoursConfig): boolean {
  const local = DateTime.fromJSDate(now, { zone });
  const [fromH, fromM] = quietHours.from.split(':').map(Number);
  const [toH, toM] = quietHours.to.split(':').map(Number);
  const minutesNow = local.hour * 60 + local.minute;
  const fromMin = fromH * 60 + fromM;
  const toMin = toH * 60 + toM;

  if (fromMin === toMin) return false; // zero-width window never suppresses
  if (fromMin < toMin) {
    // Same-day window, e.g. 12:00-13:00.
    return minutesNow >= fromMin && minutesNow < toMin;
  }
  // Wraps midnight, e.g. 21:00-06:00.
  return minutesNow >= fromMin || minutesNow < toMin;
}

/** Evaluates throttle + cooldown + quiet hours, in that order, returning the first block. */
export function evaluateAlertPolicy(input: AlertPolicyInput): AlertPolicyDecision {
  const throttle = input.throttle ?? undefined;

  if (throttle?.perDriverPerDay !== undefined && input.deliveriesTodayCount >= throttle.perDriverPerDay) {
    return { allowed: false, reason: 'THROTTLED' };
  }

  if (throttle?.cooldownMin !== undefined && input.lastDeliveredAt) {
    const elapsedMin = (input.now.getTime() - input.lastDeliveredAt.getTime()) / 60_000;
    if (elapsedMin < throttle.cooldownMin) {
      return { allowed: false, reason: 'COOLDOWN' };
    }
  }

  if (input.quietHours && !input.bypassQuietHours && isWithinQuietHours(input.now, input.zone, input.quietHours)) {
    return { allowed: false, reason: 'QUIET_HOURS' };
  }

  return { allowed: true };
}

/** Start of the subject-local calendar day, as a UTC Date — used to bound the "today" count query. */
export function startOfLocalDay(now: Date, zone: string): Date {
  return DateTime.fromJSDate(now, { zone }).startOf('day').toUTC().toJSDate();
}
