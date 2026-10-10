/**
 * §20 B-4 — server-side day segmentation for `GET /vehicles/:id/histories?date=`.
 *
 * A day of `TelemetryPoint` rows (sampled roughly every `periodicConnectedSec`, TZ §5.6) is
 * NEVER shipped to the browser raw (~60k points/day) — this segments it into DRIVE/STOP/IDLE
 * runs server-side, matching `web/src/shared/api/vehicles.ts#VehicleHistoriesResponse` exactly
 * (the frontend type takes precedence over the tz.md §20 sketch — see backend_tasks.md §7).
 *
 * Classification (no richer signal exists on `TelemetryPoint`):
 *  - DRIVE: speedMph > MOVING_THRESHOLD_MPH
 *  - IDLE:  not moving, engine on
 *  - STOP:  not moving, engine off (or unknown — treated as off, the conservative read for a
 *           day that must still balance engineOnSec + engineOffSec against the day span)
 */
export const MOVING_THRESHOLD_MPH = 3;
/** Assumed idle burn when `totalFuelIdleGal` deltas are unavailable (no diagnostic port support). */
const FALLBACK_IDLE_GPH = 0.8;

export interface HistoryPoint {
  time: Date;
  speedMph: number | null;
  engineOn: boolean | null;
  odometerMi: number | null;
  totalFuelIdleGal: number | null;
  driverId: string | null;
  /** `null` for a point without a GPS fix (PT SDK 6.11). */
  lat: number | null;
  lon: number | null;
}

export interface RouteSegment {
  marker: string;
  type: 'DRIVE' | 'STOP' | 'IDLE';
  startAt: string;
  endAt: string;
  durationSec: number;
  location: string;
  distanceMi: number | null;
  odometerMi: number;
  driverName: string;
  /** Last known fix at/before the segment end (else the first after it); `null` only when the
   * whole day has no located point. */
  lat: number | null;
  lon: number | null;
}

export interface VehicleHistoriesResponse {
  date: string;
  distanceMi: number;
  driveSegments: number;
  driveTimeSec: number;
  avgSpeedMph: number;
  stopCount: number;
  stopTimeSec: number;
  idleTimeSec: number;
  idleFuelWastedGal: number;
  firstMovementAt: string | null;
  lastMovementAt: string | null;
  engineOnSec: number;
  engineOffSec: number;
  longestDrive: { label: string; durationSec: number };
  longestStop: { label: string; durationSec: number };
  maxSpeedMph: number;
  maxSpeedAt: string | null;
  segments: RouteSegment[];
}

function classify(p: HistoryPoint): 'DRIVE' | 'STOP' | 'IDLE' {
  if ((p.speedMph ?? 0) > MOVING_THRESHOLD_MPH) return 'DRIVE';
  return p.engineOn ? 'IDLE' : 'STOP';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function locationLabel(p: { lat: number | null; lon: number | null }): string {
  if (p.lat === null || p.lon === null) return 'Unknown location';
  return `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
}

/** Fills fix-less points with the last known fix (else the next one) so a segment still has a
 * place; the input is time-ordered. */
function fillPositions(sorted: HistoryPoint[]): HistoryPoint[] {
  const out = sorted.map((p) => ({ ...p }));
  let last: { lat: number; lon: number } | null = null;
  for (const p of out) {
    if (p.lat !== null && p.lon !== null) last = { lat: p.lat, lon: p.lon };
    else if (last) Object.assign(p, last);
  }
  let next: { lat: number; lon: number } | null = null;
  for (let i = out.length - 1; i >= 0; i--) {
    const p = out[i];
    if (p.lat !== null && p.lon !== null) next = { lat: p.lat, lon: p.lon };
    else if (next) Object.assign(p, next);
  }
  return out;
}

export function buildVehicleHistories(
  date: string,
  points: HistoryPoint[],
  driverNameById: Map<string, string>,
): VehicleHistoriesResponse {
  const empty: VehicleHistoriesResponse = {
    date,
    distanceMi: 0,
    driveSegments: 0,
    driveTimeSec: 0,
    avgSpeedMph: 0,
    stopCount: 0,
    stopTimeSec: 0,
    idleTimeSec: 0,
    idleFuelWastedGal: 0,
    firstMovementAt: null,
    lastMovementAt: null,
    engineOnSec: 0,
    engineOffSec: 0,
    longestDrive: { label: '', durationSec: 0 },
    longestStop: { label: '', durationSec: 0 },
    maxSpeedMph: 0,
    maxSpeedAt: null,
    segments: [],
  };
  if (points.length === 0) return empty;

  const sorted = fillPositions([...points].sort((a, b) => a.time.getTime() - b.time.getTime()));

  const groups: HistoryPoint[][] = [];
  let currentType: 'DRIVE' | 'STOP' | 'IDLE' | null = null;
  for (const p of sorted) {
    const type = classify(p);
    if (type === currentType && groups.length > 0) {
      groups[groups.length - 1].push(p);
    } else {
      groups.push([p]);
      currentType = type;
    }
  }

  const segments: RouteSegment[] = groups.map((group, i) => {
    const type = classify(group[0]);
    const startAt = group[0].time;
    const endAt = i < groups.length - 1 ? groups[i + 1][0].time : group[group.length - 1].time;
    const durationSec = Math.max(0, Math.round((endAt.getTime() - startAt.getTime()) / 1000));
    const last = group[group.length - 1];
    const first = group[0];
    const distanceMi =
      type === 'DRIVE' && first.odometerMi != null && last.odometerMi != null
        ? round1(Math.max(0, last.odometerMi - first.odometerMi))
        : null;
    const driverCounts = new Map<string, number>();
    for (const p of group) if (p.driverId) driverCounts.set(p.driverId, (driverCounts.get(p.driverId) ?? 0) + 1);
    let topDriverId: string | null = null;
    let topCount = 0;
    for (const [id, count] of driverCounts) if (count > topCount) { topDriverId = id; topCount = count; }
    return {
      marker: String(i + 1),
      type,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      durationSec,
      location: locationLabel(last),
      distanceMi,
      odometerMi: last.odometerMi ?? 0,
      driverName: (topDriverId && driverNameById.get(topDriverId)) || 'Unassigned',
      lat: last.lat,
      lon: last.lon,
    };
  });

  const driveSegs = segments.filter((s) => s.type === 'DRIVE');
  const stopSegs = segments.filter((s) => s.type === 'STOP');
  const idleSegs = segments.filter((s) => s.type === 'IDLE');

  const driveTimeSec = driveSegs.reduce((sum, s) => sum + s.durationSec, 0);
  const stopTimeSec = stopSegs.reduce((sum, s) => sum + s.durationSec, 0);
  const idleTimeSec = idleSegs.reduce((sum, s) => sum + s.durationSec, 0);
  const distanceMi = round1(driveSegs.reduce((sum, s) => sum + (s.distanceMi ?? 0), 0));
  const avgSpeedMph = driveTimeSec > 0 ? round1(distanceMi / (driveTimeSec / 3600)) : 0;

  const firstFuel = sorted.find((p) => p.totalFuelIdleGal != null)?.totalFuelIdleGal ?? null;
  const lastFuel = [...sorted].reverse().find((p) => p.totalFuelIdleGal != null)?.totalFuelIdleGal ?? null;
  const idleFuelWastedGal =
    firstFuel != null && lastFuel != null
      ? round1(Math.max(0, lastFuel - firstFuel))
      : round1((idleTimeSec / 3600) * FALLBACK_IDLE_GPH);

  const longestDrive = driveSegs.reduce(
    (max, s) => (s.durationSec > max.durationSec ? { label: s.location, durationSec: s.durationSec } : max),
    { label: '', durationSec: 0 },
  );
  const longestStop = stopSegs.reduce(
    (max, s) => (s.durationSec > max.durationSec ? { label: s.location, durationSec: s.durationSec } : max),
    { label: '', durationSec: 0 },
  );

  let maxSpeedMph = 0;
  let maxSpeedAt: string | null = null;
  for (const p of sorted) {
    if ((p.speedMph ?? 0) > maxSpeedMph) {
      maxSpeedMph = p.speedMph ?? 0;
      maxSpeedAt = p.time.toISOString();
    }
  }

  return {
    date,
    distanceMi,
    driveSegments: driveSegs.length,
    driveTimeSec,
    avgSpeedMph,
    stopCount: stopSegs.length,
    stopTimeSec,
    idleTimeSec,
    idleFuelWastedGal,
    firstMovementAt: driveSegs[0]?.startAt ?? null,
    lastMovementAt: driveSegs[driveSegs.length - 1]?.endAt ?? null,
    engineOnSec: driveTimeSec + idleTimeSec,
    engineOffSec: stopTimeSec,
    longestDrive,
    longestStop,
    maxSpeedMph,
    maxSpeedAt,
    segments,
  };
}
