/**
 * OneBook ELD — pure helpers for the `fleet` mock generator, split out of fleet.ts so they can be
 * unit-tested without a live Prisma connection (see fleet.helpers.spec.ts).
 */
import { DateTime } from 'luxon';

export function dateKey(dt: DateTime): string {
  return dt.toFormat('yyyy-LL-dd');
}

export interface DrivingDaySpan {
  day: string;
  first: Date;
  last: Date;
  vehicleId: string | null;
}

/**
 * Groups a driver's DUTY_STATUS=Driving EldEvents into calendar-day (home-terminal tz) spans,
 * sorted ascending by the first event of the day. Used to align DVIR/trip mock data with real
 * `hos` EldEvent driving days (tz.md — the RODS day boundary always follows the driver's home
 * terminal timezone, never UTC or the carrier's).
 */
export function groupDrivingDays(
  events: Array<{ vehicleId: string | null; eventDateTime: Date }>,
  tz: string,
): DrivingDaySpan[] {
  const byDay = new Map<string, { first: Date; last: Date; vehicleId: string | null }>();
  for (const e of events) {
    const dt = DateTime.fromJSDate(e.eventDateTime).setZone(tz);
    const key = dateKey(dt);
    const existing = byDay.get(key);
    if (!existing) {
      byDay.set(key, { first: e.eventDateTime, last: e.eventDateTime, vehicleId: e.vehicleId });
    } else {
      if (e.eventDateTime < existing.first) existing.first = e.eventDateTime;
      if (e.eventDateTime > existing.last) existing.last = e.eventDateTime;
      if (!existing.vehicleId) existing.vehicleId = e.vehicleId;
    }
  }
  return [...byDay.entries()]
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => (a.first < b.first ? -1 : 1));
}
