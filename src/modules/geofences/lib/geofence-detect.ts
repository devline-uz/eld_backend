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
}

export interface Point {
  lat: number;
  lon: number;
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
  points: Point[],
  fence: CircleGeofence,
  wasInside: boolean | null,
): GeofenceTransition[] {
  if (!fence.alertOnEnter && !fence.alertOnExit) return [];

  let prev = wasInside;
  let net: GeofenceTransition | null = null;
  for (const point of points) {
    const inside = isInsideGeofence(point, fence);
    if (prev !== null && inside !== prev) {
      const kind: GeofenceTransitionKind = inside ? 'ENTER' : 'EXIT';
      if ((kind === 'ENTER' && fence.alertOnEnter) || (kind === 'EXIT' && fence.alertOnExit)) {
        // Only the LAST net direction change in the batch is alert-worthy.
        net = { geofenceId: fence.id, kind };
      }
    }
    prev = inside;
  }
  return net ? [net] : [];
}
