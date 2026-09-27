import { DateTime } from 'luxon';
import { distanceMi } from '../../../common/units';

/** TZ §11.5 (`GET/POST /geofences`) + §12.5 `trip.status_changed`-style event stream.
 * CIRCLE geofences only — `polygon` geofences exist in the schema for Figma's draw-tool but
 * point-in-polygon crossing detection is a v2 follow-up (documented in decisions.md D-0xx). */
export interface CircleGeofence {
  id: string;
  centerLat: number;
  centerLon: number;
  radiusMi: number;
  alertOnEnter: boolean;
  alertOnExit: boolean;
  /** §20 B-15 — when set, ENTER/EXIT only alert during "after hours"; see `isAfterHours`. */
  afterHoursOnly?: boolean;
}

export interface Point {
  lat: number;
  lon: number;
}

/** §20 B-15 "After-hours entry" — outside the fixed 06:00–20:00 local business-hours window.
 * No per-carrier business-hours config exists yet, so this window is hardcoded and documented
 * (decisions.md) rather than left silently unimplemented. */
export function isAfterHours(at: Date, zone: string): boolean {
  const local = DateTime.fromJSDate(at, { zone });
  const minutes = local.hour * 60 + local.minute;
  return minutes < 6 * 60 || minutes >= 20 * 60;
}

/** §20 B-15 "Dwell longer than N min" — true once `atTime` is `dwellMinutes` or more after
 * `enteredAt`. Pure so the threshold boundary is unit-testable without a clock/DB. */
export function isDwellExceeded(enteredAt: Date, atTime: Date, dwellMinutes: number): boolean {
  return (atTime.getTime() - enteredAt.getTime()) / 60_000 >= dwellMinutes;
}

export type GeofenceTransitionKind = 'ENTER' | 'EXIT';

export interface GeofenceTransition {
  geofenceId: string;
  kind: GeofenceTransitionKind;
}

/** Inclusive boundary: exactly-on-the-radius counts as inside (matches `<=`, not `<`). */
export function isInsideGeofence(point: Point, fence: CircleGeofence): boolean {
  return distanceMi(point, { lat: fence.centerLat, lon: fence.centerLon }) <= fence.radiusMi;
}

/**
 * Walks an ordered batch of points against one geofence, starting from `wasInside`
 * (the last known state, from telemetry stored before this batch — or `null` when
 * there is no prior point, in which case the first point never produces a transition,
 * only establishes the baseline). Returns at most one ENTER and one EXIT per fence per
 * call — repeated crossings inside the same batch collapse to the LAST net state, since
 * only the net transition is alert-worthy.
 */
export function detectGeofenceTransitions(
  points: Array<Point & { time?: string }>,
  fence: CircleGeofence,
  wasInside: boolean | null,
  zone = 'UTC',
): GeofenceTransition[] {
  if (!fence.alertOnEnter && !fence.alertOnExit) return [];

  let prev = wasInside;
  let net: GeofenceTransition | null = null;
  for (const point of points) {
    const inside = isInsideGeofence(point, fence);
    if (prev !== null && inside !== prev) {
      const kind: GeofenceTransitionKind = inside ? 'ENTER' : 'EXIT';
      const gated = (kind === 'ENTER' && fence.alertOnEnter) || (kind === 'EXIT' && fence.alertOnExit);
      // §20 B-15 "After-hours entry" — a timed point is filtered to after-hours only; an
      // untimed one (legacy callers/tests) is never filtered, preserving prior behaviour.
      const withinHours = !fence.afterHoursOnly || !point.time || isAfterHours(new Date(point.time), zone);
      if (gated && withinHours) {
        // Only the LAST net direction change in the batch is alert-worthy.
        net = { geofenceId: fence.id, kind };
      }
    }
    prev = inside;
  }
  return net ? [net] : [];
}
