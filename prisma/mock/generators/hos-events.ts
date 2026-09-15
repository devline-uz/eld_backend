/**
 * Mock HOS generator — PURE §395 record builder (no DB). Turns planned duty segments into
 * `EldEvent` rows: duty changes, hourly intermediate logs, login/logout, engine power, PC/YM
 * indications, certifications, malfunction/diagnostic records and §9.3 driver self-edits.
 *
 * Positions come from the VEHICLE, not the driver: every vehicle has a route along a real
 * interstate corridor (or a metro loop for local work) and a motion model built from every
 * driving interval recorded on it, so odometer, engine hours and location are continuous and
 * monotonic per vehicle even when co-drivers share a truck.
 */
import { createHash } from 'node:crypto';
import { coarsenLocation, distanceMi } from '../../../src/common/units/location';
import { addDays, offsetMs } from '../../../src/modules/hos/engine/timezone';
import type { DutyStatus } from '../../../src/modules/hos/hos.types';
import { computeChecksum } from '../../../src/modules/ingest/checksum';
import type { MockRng } from '../context';
import { DAY, H, M, effective, fastDayStart, type EditPlan, type Seg } from './hos-schedule';

/** "mock" in hex — every EldEvent this generator writes has a uuid starting with this group. */
export const HOS_EVENT_UUID_PREFIX = '6d6f636b-';

const DUTY_CODE: Record<DutyStatus, number> = { OFF: 1, SB: 2, D: 3, ON: 4 };

// ---------------------------------------------------------------------------------------------
// Corridors
// ---------------------------------------------------------------------------------------------

export interface Waypoint {
  name: string;
  lat: number;
  lon: number;
}

const w = (name: string, lat: number, lon: number): Waypoint => ({ name, lat, lon });

export const CORRIDORS: Record<string, Waypoint[]> = {
  'I-95': [
    w('Miami, FL', 25.7617, -80.1918), w('West Palm Beach, FL', 26.7153, -80.0534), w('Daytona Beach, FL', 29.2108, -81.0228),
    w('Jacksonville, FL', 30.3322, -81.6557), w('Savannah, GA', 32.0809, -81.0912), w('Florence, SC', 34.1954, -79.7626),
    w('Fayetteville, NC', 35.0527, -78.8784), w('Richmond, VA', 37.5407, -77.436), w('Washington, DC', 38.9072, -77.0369),
    w('Baltimore, MD', 39.2904, -76.6122), w('Philadelphia, PA', 39.9526, -75.1652), w('Newark, NJ', 40.7357, -74.1724),
    w('New Haven, CT', 41.3083, -72.9279), w('Providence, RI', 41.824, -71.4128), w('Boston, MA', 42.3601, -71.0589),
  ],
  'I-75': [
    w('Tampa, FL', 27.9506, -82.4572), w('Ocala, FL', 29.1872, -82.1401), w('Valdosta, GA', 30.8327, -83.2785),
    w('Macon, GA', 32.8407, -83.6324), w('Atlanta, GA', 33.749, -84.388), w('Chattanooga, TN', 35.0456, -85.3097),
    w('Knoxville, TN', 35.9606, -83.9207), w('Lexington, KY', 38.0406, -84.5037), w('Cincinnati, OH', 39.1031, -84.512),
    w('Dayton, OH', 39.7589, -84.1916), w('Toledo, OH', 41.6528, -83.5379), w('Detroit, MI', 42.3314, -83.0458),
  ],
  'I-85': [
    w('Atlanta, GA', 33.749, -84.388), w('Greenville, SC', 34.8526, -82.394), w('Charlotte, NC', 35.2271, -80.8431),
    w('Greensboro, NC', 36.0726, -79.792), w('Durham, NC', 35.994, -78.8986), w('Petersburg, VA', 37.2279, -77.4019),
    w('Richmond, VA', 37.5407, -77.436),
  ],
  'I-80E': [
    w('Newark, NJ', 40.7357, -74.1724), w('Stroudsburg, PA', 40.9868, -75.1946), w('Clearfield, PA', 41.027, -78.4392),
    w('Youngstown, OH', 41.0998, -80.6495), w('Cleveland, OH', 41.4993, -81.6944), w('Toledo, OH', 41.6528, -83.5379),
    w('South Bend, IN', 41.6764, -86.252), w('Chicago, IL', 41.8781, -87.6298),
  ],
  'I-35': [
    w('Laredo, TX', 27.5306, -99.4803), w('San Antonio, TX', 29.4241, -98.4936), w('Austin, TX', 30.2672, -97.7431),
    w('Waco, TX', 31.5493, -97.1467), w('Dallas, TX', 32.7767, -96.797), w('Oklahoma City, OK', 35.4676, -97.5164),
    w('Wichita, KS', 37.6872, -97.3301), w('Kansas City, MO', 39.0997, -94.5786), w('Des Moines, IA', 41.5868, -93.625),
    w('Minneapolis, MN', 44.9778, -93.265),
  ],
  'I-10C': [
    w('Houston, TX', 29.7604, -95.3698), w('Beaumont, TX', 30.0802, -94.1266), w('Lake Charles, LA', 30.2266, -93.2174),
    w('Baton Rouge, LA', 30.4515, -91.1871), w('New Orleans, LA', 29.9511, -90.0715), w('Mobile, AL', 30.6954, -88.0399),
    w('Pensacola, FL', 30.4213, -87.2169),
  ],
  'I-40C': [
    w('Memphis, TN', 35.1495, -90.049), w('Little Rock, AR', 34.7465, -92.2896), w('Fort Smith, AR', 35.3859, -94.3985),
    w('Oklahoma City, OK', 35.4676, -97.5164), w('Amarillo, TX', 35.222, -101.8313),
  ],
  'I-55': [
    w('Chicago, IL', 41.8781, -87.6298), w('Springfield, IL', 39.7817, -89.6501), w('St. Louis, MO', 38.627, -90.1994),
    w('Memphis, TN', 35.1495, -90.049), w('Jackson, MS', 32.2988, -90.1848), w('New Orleans, LA', 29.9511, -90.0715),
  ],
  'I-94': [
    w('Chicago, IL', 41.8781, -87.6298), w('Milwaukee, WI', 43.0389, -87.9065), w('Madison, WI', 43.0731, -89.4012),
    w('Eau Claire, WI', 44.8113, -91.4985), w('Minneapolis, MN', 44.9778, -93.265), w('Fargo, ND', 46.8772, -96.7898),
  ],
  'I-25': [
    w('Albuquerque, NM', 35.0844, -106.6504), w('Pueblo, CO', 38.2544, -104.6091), w('Colorado Springs, CO', 38.8339, -104.8214),
    w('Denver, CO', 39.7392, -104.9903), w('Cheyenne, WY', 41.14, -104.8202),
  ],
  'I-80W': [
    w('Cheyenne, WY', 41.14, -104.8202), w('Laramie, WY', 41.3114, -105.5911), w('Rock Springs, WY', 41.5875, -109.2029),
    w('Salt Lake City, UT', 40.7608, -111.891),
  ],
  'I-10W': [
    w('El Paso, TX', 31.7619, -106.485), w('Las Cruces, NM', 32.3199, -106.7637), w('Tucson, AZ', 32.2226, -110.9747),
    w('Phoenix, AZ', 33.4484, -112.074), w('Blythe, CA', 33.6103, -114.5964), w('Palm Springs, CA', 33.8303, -116.5453),
    w('Los Angeles, CA', 34.0522, -118.2437),
  ],
  'I-40W': [
    w('Phoenix, AZ', 33.4484, -112.074), w('Flagstaff, AZ', 35.1983, -111.6513), w('Kingman, AZ', 35.1894, -114.053),
    w('Barstow, CA', 34.8958, -117.0173),
  ],
  'I-5': [
    w('San Diego, CA', 32.7157, -117.1611), w('Los Angeles, CA', 34.0522, -118.2437), w('Bakersfield, CA', 35.3733, -119.0187),
    w('Stockton, CA', 37.9577, -121.2908), w('Sacramento, CA', 38.5816, -121.4944), w('Redding, CA', 40.5865, -122.3917),
    w('Medford, OR', 42.3265, -122.8756), w('Eugene, OR', 44.0521, -123.0868), w('Portland, OR', 45.5152, -122.6784),
    w('Seattle, WA', 47.6062, -122.3321),
  ],
  'I-15': [
    w('Los Angeles, CA', 34.0522, -118.2437), w('Barstow, CA', 34.8958, -117.0173), w('Las Vegas, NV', 36.1699, -115.1398),
    w('St. George, UT', 37.0965, -113.5684), w('Salt Lake City, UT', 40.7608, -111.891),
  ],
};

const CORRIDORS_BY_TZ: Record<string, string[]> = {
  'America/New_York': ['I-95', 'I-75', 'I-85', 'I-80E'],
  'America/Detroit': ['I-75', 'I-80E'],
  'America/Chicago': ['I-35', 'I-10C', 'I-40C', 'I-55', 'I-94'],
  'America/Denver': ['I-25', 'I-80W'],
  'America/Phoenix': ['I-10W', 'I-40W'],
  'America/Los_Angeles': ['I-5', 'I-15'],
};

export function corridorsForTimezone(timezone: string): string[] {
  return CORRIDORS_BY_TZ[timezone] ?? CORRIDORS_BY_TZ['America/New_York'];
}

/** The corridor waypoint whose city matches a home-terminal label like "Atlanta, GA — Terminal". */
export function findCity(label: string | null | undefined): { corridor: string; index: number; point: Waypoint } | null {
  if (!label) return null;
  const lower = label.toLowerCase();
  for (const [corridor, points] of Object.entries(CORRIDORS)) {
    const index = points.findIndex((p) => lower.includes(p.name.split(',')[0].toLowerCase()));
    if (index >= 0) return { corridor, index, point: points[index] };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export interface Route {
  points: Waypoint[];
  cum: number[];
  length: number;
  loop: boolean;
}

const ROAD_FACTOR = 1.15;

export function buildRoute(points: Waypoint[], loop = false): Route {
  const pts = loop ? [...points, points[0]] : points;
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + distanceMi(pts[i - 1], pts[i]) * ROAD_FACTOR);
  return { points: pts, cum, length: cum[cum.length - 1], loop };
}

/** A ~30–45 mile loop around a city — local/short-haul work stays far inside 150 air-miles. */
export function metroLoop(center: Waypoint, rng: MockRng): Route {
  const points: Waypoint[] = [];
  const n = 6;
  for (let i = 0; i < n; i += 1) {
    const radiusMi = rng.float(18, 42);
    const angle = (i / n) * 2 * Math.PI + rng.float(-0.3, 0.3);
    const lat = center.lat + (radiusMi / 69) * Math.cos(angle);
    const lon = center.lon + (radiusMi / (69 * Math.cos((center.lat * Math.PI) / 180))) * Math.sin(angle);
    points.push({ name: center.name, lat, lon });
  }
  return buildRoute([center, ...points], true);
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function compass(from: Waypoint, to: { lat: number; lon: number }): string {
  const dy = to.lat - from.lat;
  const dx = (to.lon - from.lon) * Math.cos((from.lat * Math.PI) / 180);
  const deg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

export function positionAt(route: Route, miles: number): { lat: number; lon: number; name: string; city: string } {
  if (route.length <= 0) {
    const p = route.points[0];
    return { lat: p.lat, lon: p.lon, name: p.name, city: p.name };
  }
  const period = route.loop ? route.length : 2 * route.length;
  let d = ((miles % period) + period) % period;
  if (!route.loop && d > route.length) d = period - d;
  let lo = 0;
  let hi = route.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (route.cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const a = route.points[lo];
  const b = route.points[hi];
  const span = route.cum[hi] - route.cum[lo];
  const frac = span > 0 ? (d - route.cum[lo]) / span : 0;
  const lat = a.lat + (b.lat - a.lat) * frac;
  const lon = a.lon + (b.lon - a.lon) * frac;
  const nearest = frac < 0.5 ? a : b;
  const dist = distanceMi(nearest, { lat, lon });
  const name = dist < 1 ? nearest.name : `${Math.round(dist)} mi ${compass(nearest, { lat, lon })} ${nearest.name}`;
  return { lat, lon, name, city: nearest.name };
}

// ---------------------------------------------------------------------------------------------
// Vehicle motion — odometer and engine hours as monotonic functions of time
// ---------------------------------------------------------------------------------------------

export interface Motion {
  start: number;
  end: number;
  mph: number;
}

export class VehicleMotion {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  private readonly mph: number[] = [];
  private readonly milesBefore: number[] = [];
  private readonly hoursBefore: number[] = [];
  readonly totalMiles: number;
  readonly totalHours: number;

  constructor(motions: Motion[]) {
    const sorted = motions.filter((m) => m.end > m.start).sort((a, b) => a.start - b.start);
    let miles = 0;
    let hours = 0;
    let lastEnd = -Infinity;
    for (const m of sorted) {
      const start = Math.max(m.start, lastEnd);
      if (m.end <= start) continue;
      this.starts.push(start);
      this.ends.push(m.end);
      this.mph.push(m.mph);
      this.milesBefore.push(miles);
      this.hoursBefore.push(hours);
      const h = (m.end - start) / H;
      miles += h * m.mph;
      hours += h;
      lastEnd = m.end;
    }
    this.totalMiles = miles;
    this.totalHours = hours;
  }

  private locate(t: number): { miles: number; hours: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    if (hi < 0 || t <= this.starts[0]) return { miles: 0, hours: 0 };
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    const inside = Math.min(t, this.ends[lo]) - this.starts[lo];
    const h = inside / H;
    return { miles: this.milesBefore[lo] + h * this.mph[lo], hours: this.hoursBefore[lo] + h };
  }

  milesAt(t: number): number {
    return this.locate(t).miles;
  }

  hoursAt(t: number): number {
    return this.locate(t).hours;
  }

  /** Merged busy intervals (for finding idle gaps). */
  intervals(): Array<[number, number]> {
    return this.starts.map((s, i) => [s, this.ends[i]]);
  }
}

/** Movement recorded on a vehicle by a driver timeline: driving, PC (slow), YM (crawl). */
export function motionsFromSegments(segments: Seg[], mphFor: (seg: Seg) => number): Map<string, Motion[]> {
  const out = new Map<string, Motion[]>();
  for (const s of segments) {
    if (!s.vehicleId) continue;
    const moving = s.status === 'D' || s.special === 'PC' || s.special === 'YM';
    if (!moving) continue;
    const mph = s.special === 'YM' ? 4 : s.special === 'PC' ? 28 : mphFor(s);
    const list = out.get(s.vehicleId) ?? [];
    list.push({ start: s.start, end: s.end, mph });
    out.set(s.vehicleId, list);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

export interface VehicleCtx {
  id: string;
  deviceId: string | null;
  offsetMi: number;
  baseMi: number;
  baseEngineHours: number;
  motion: VehicleMotion;
  route: Route;
  routeOffsetMi: number;
}

export interface EventRow {
  uuid: string;
  driverId: string | null;
  vehicleId: string | null;
  deviceId: string | null;
  eventType: number;
  eventCode: number;
  eventSequenceId: number;
  eventDateTime: Date;
  timezoneOffset: number;
  recordStatus: number;
  recordOrigin: number;
  latitude: number | null;
  longitude: number | null;
  locationPrecisionMi: number;
  locationName: string | null;
  distanceSinceLastValidCoords: number | null;
  totalVehicleMiles: number | null;
  rawDeviceOdometerKm: number | null;
  totalEngineHours: number | null;
  malfunctionCode: string | null;
  diagnosticCode: string | null;
  annotation: string | null;
  comment: string | null;
  /** Resolved to `supersedesId` once the superseded row has a database id. */
  supersedesUuid: string | null;
  editedById: string | null;
  editorType: 'DRIVER' | 'USER' | 'SYSTEM' | null;
  editReason: string | null;
  wasStoredOnDevice: boolean;
  receivedAt: Date;
  uploadedByDriverId: string | null;
  checksum: string;
  createdAt: Date;
  /** 1 = recorded by the ELD; 2 = appended later by a §9.3 edit (needs ids of phase 1). */
  phase: 1 | 2;
}

type Draft = Omit<EventRow, 'eventSequenceId' | 'checksum' | 'receivedAt' | 'createdAt' | 'eventDateTime' | 'timezoneOffset'> & {
  at: number;
  recordedAt: number;
  order: number;
};

export function mockUuid(seed: string): string {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${HOS_EVENT_UUID_PREFIX}${h.slice(0, 4)}-4${h.slice(4, 7)}-${'89ab'[parseInt(h[7], 16) % 4]}${h.slice(8, 11)}-${h.slice(11, 23)}`;
}

const offsetCache = new Map<string, number>();
function tzOffsetMin(timezone: string, at: number): number {
  const key = `${timezone}|${Math.floor(at / H)}`;
  let value = offsetCache.get(key);
  if (value === undefined) {
    value = Math.round(offsetMs(timezone, new Date(Math.floor(at / H) * H)) / 60_000);
    offsetCache.set(key, value);
  }
  return value;
}

const round = (value: number, digits: number): number => Number(value.toFixed(digits));

function blankDraft(): Omit<Draft, 'uuid' | 'eventType' | 'eventCode' | 'at' | 'recordedAt' | 'order'> {
  return {
    driverId: null,
    vehicleId: null,
    deviceId: null,
    recordStatus: 1,
    recordOrigin: 1,
    latitude: null,
    longitude: null,
    locationPrecisionMi: 1,
    locationName: null,
    distanceSinceLastValidCoords: null,
    totalVehicleMiles: null,
    rawDeviceOdometerKm: null,
    totalEngineHours: null,
    malfunctionCode: null,
    diagnosticCode: null,
    annotation: null,
    comment: null,
    supersedesUuid: null,
    editedById: null,
    editorType: null,
    editReason: null,
    wasStoredOnDevice: false,
    uploadedByDriverId: null,
    phase: 1,
  };
}

function stamp(vehicles: Map<string, VehicleCtx>, vehicleId: string | null, at: number, tenMile: boolean): Partial<Draft> {
  const v = vehicleId ? vehicles.get(vehicleId) : undefined;
  if (!v) return { vehicleId };
  const traveled = v.motion.milesAt(at);
  const pos = positionAt(v.route, v.routeOffsetMi + traveled);
  const coarse = coarsenLocation({ lat: pos.lat, lon: pos.lon }, tenMile ? 'TEN_MILE' : 'ONE_MILE');
  const odometer = v.baseMi + traveled;
  return {
    vehicleId: v.id,
    deviceId: v.deviceId,
    latitude: round(coarse.lat, 6),
    longitude: round(coarse.lon, 6),
    locationPrecisionMi: tenMile ? 10 : 1,
    locationName: (tenMile ? pos.city : pos.name).slice(0, 60),
    distanceSinceLastValidCoords: 0,
    totalVehicleMiles: Math.round(odometer),
    rawDeviceOdometerKm: Math.max(0, Math.round((odometer - v.offsetMi) * 1.609344)),
    totalEngineHours: round(v.baseEngineHours + v.motion.hoursAt(at) * 1.3, 2),
  };
}

function finalize(drafts: Draft[], timezone: string, now: number): EventRow[] {
  const live = drafts.filter((d) => d.at <= now && d.recordedAt <= now);
  live.sort((a, b) => a.recordedAt - b.recordedAt || a.at - b.at || a.order - b.order);
  return live.map((d, index) => {
    const eventDateTime = new Date(d.at);
    const receivedAt = new Date(Math.min(now, d.recordedAt + 4000));
    const timezoneOffset = tzOffsetMin(timezone, d.at);
    const checksum = computeChecksum({
      uuid: d.uuid,
      eventType: d.eventType,
      eventCode: d.eventCode,
      eventDateTime,
      timezoneOffset,
      recordOrigin: d.recordOrigin,
      recordStatus: d.recordStatus,
      latitude: d.latitude,
      longitude: d.longitude,
      rawDeviceOdometerKm: d.rawDeviceOdometerKm,
      totalEngineHours: d.totalEngineHours,
    });
    const { at: _at, recordedAt: _rec, order: _order, ...rest } = d;
    void _at;
    void _rec;
    void _order;
    return { ...rest, eventSequenceId: (index % 65535) + 1, eventDateTime, timezoneOffset, receivedAt, createdAt: receivedAt, checksum };
  });
}

export interface CertDay {
  date: string;
  certified: boolean;
  certifiedAt: number | null;
  count: number;
  events: Array<{ at: number; code: number }>;
}

export interface DriverEventsInput {
  driverId: string;
  timezone: string;
  segments: Seg[];
  edits: EditPlan[];
  /** Called with the edits that were actually applied, so a recertification is never invented. */
  planCerts: (logins: number[], appliedEdits: EditPlan[]) => CertDay[];
  vehicles: Map<string, VehicleCtx>;
  now: number;
  rng: MockRng;
}

export interface DriverEventsResult {
  rows: EventRow[];
  appliedEdits: EditPlan[];
  certs: CertDay[];
}

/** Login instants only — used to plan certifications before the rows are built. */
export function loginInstants(segments: Seg[]): number[] {
  const out: number[] = [];
  let working = false;
  for (let i = 0; i < segments.length; i += 1) {
    const eff = effective(segments[i].status, segments[i].special);
    const rest = eff === 'OFF' || eff === 'SB';
    if (!rest && !working) {
      out.push(segments[i].start - 2 * M);
      working = true;
    } else if (rest && working) {
      let end = segments[i].end;
      for (let j = i + 1; j < segments.length; j += 1) {
        const e = effective(segments[j].status, segments[j].special);
        if (e !== 'OFF' && e !== 'SB') break;
        end = segments[j].end;
      }
      if (end - segments[i].start >= 2 * H || i === segments.length - 1) working = false;
    }
  }
  return out;
}

export function buildDriverEvents(input: DriverEventsInput): DriverEventsResult {
  const { driverId, timezone, segments, vehicles, now, rng } = input;
  const drafts: Draft[] = [];
  const logins: number[] = [];
  let order = 0;
  const dutyAt = new Map<number, { uuid: string; code: number }>();

  const push = (fields: Partial<Draft> & { eventType: number; eventCode: number; at: number; recordedAt: number }): Draft => {
    order += 1;
    const draft: Draft = {
      ...blankDraft(),
      driverId,
      uploadedByDriverId: driverId,
      ...fields,
      uuid: mockUuid(`${driverId}:${order}`),
      order,
    } as Draft;
    drafts.push(draft);
    return draft;
  };

  const n = segments.length;
  const restRunEnd = new Array<number>(n).fill(-1);
  for (let i = n - 1; i >= 0; i -= 1) {
    const eff = effective(segments[i].status, segments[i].special);
    if (eff !== 'OFF' && eff !== 'SB') continue;
    const next = segments[i + 1];
    const nextRest = next && next.start === segments[i].end && ['OFF', 'SB'].includes(effective(next.status, next.special));
    restRunEnd[i] = nextRest ? restRunEnd[i + 1] : i === n - 1 ? Math.max(segments[i].end, now) : segments[i].end;
  }

  let prevStatus: DutyStatus | null = null;
  let prevSpecial = 'NONE';
  let working = false;
  let delay = 0;
  const driveSegs: Seg[] = [];

  for (let i = 0; i < n; i += 1) {
    const s = segments[i];
    const eff = effective(s.status, s.special);
    const rest = eff === 'OFF' || eff === 'SB';
    const tenMile = s.special === 'PC';

    if (!rest && !working) {
      working = true;
      delay = rng.chance(0.05) ? rng.int(15, 180) * M : 0;
      const loginAt = s.start - 2 * M;
      logins.push(loginAt);
      push({ eventType: 5, eventCode: 1, at: loginAt, recordedAt: loginAt + delay, wasStoredOnDevice: delay > 0, ...stamp(vehicles, s.vehicleId, loginAt, false) });
      if (!s.team) {
        push({ eventType: 6, eventCode: 1, at: s.start - M, recordedAt: s.start - M + delay, wasStoredOnDevice: delay > 0, ...stamp(vehicles, s.vehicleId, s.start - M, false) });
      }
    }
    const rec = s.start + delay;
    const stored = delay > 0;

    if (prevSpecial !== 'NONE' && s.special !== prevSpecial) {
      push({ eventType: 3, eventCode: 0, at: s.start, recordedAt: rec, wasStoredOnDevice: stored, ...stamp(vehicles, s.vehicleId, s.start, false) });
    }
    if (s.status !== prevStatus) {
      const d = push({ eventType: 1, eventCode: DUTY_CODE[s.status], at: s.start, recordedAt: rec, wasStoredOnDevice: stored, ...stamp(vehicles, s.vehicleId, s.start, tenMile) });
      dutyAt.set(s.start, { uuid: d.uuid, code: d.eventCode });
    }
    if (s.special !== 'NONE' && s.special !== prevSpecial) {
      push({ eventType: 3, eventCode: s.special === 'PC' ? 1 : 2, at: s.start, recordedAt: rec, wasStoredOnDevice: stored, ...stamp(vehicles, s.vehicleId, s.start, tenMile) });
    }
    if (s.status === 'D' && s.special === 'NONE') {
      driveSegs.push(s);
      for (let t = s.start + H; t < s.end; t += H) {
        push({ eventType: 2, eventCode: 1, at: t, recordedAt: t + delay, wasStoredOnDevice: stored, ...stamp(vehicles, s.vehicleId, t, false) });
      }
    } else if (s.special === 'PC') {
      for (let t = s.start + H; t < s.end; t += H) {
        push({ eventType: 2, eventCode: 2, at: t, recordedAt: t + delay, wasStoredOnDevice: stored, ...stamp(vehicles, s.vehicleId, t, true) });
      }
    }
    prevStatus = s.status;
    prevSpecial = s.special;

    if (rest && working && restRunEnd[i] - s.start >= 2 * H) {
      working = false;
      const endAt = s.special === 'PC' ? s.end : s.start;
      if (!s.team) {
        push({ eventType: 6, eventCode: 3, at: endAt + M, recordedAt: endAt + M + delay, wasStoredOnDevice: stored, ...stamp(vehicles, s.vehicleId, endAt + M, false) });
      }
      push({ eventType: 5, eventCode: 2, at: endAt + 2 * M, recordedAt: endAt + 2 * M + delay, wasStoredOnDevice: stored, ...stamp(vehicles, s.vehicleId, endAt + 2 * M, false) });
    }
  }

  // Malfunction / diagnostic records (§395 Appendix A 4.6) — rare, always cleared.
  const longDrives = driveSegs.filter((s) => s.end - s.start >= 2 * H && !s.team);
  if (longDrives.length && rng.chance(0.3)) {
    const s = rng.pick(longDrives);
    const at = s.start + 30 * M;
    const cleared = at + rng.int(5, 40) * M;
    push({ eventType: 7, eventCode: 3, at, recordedAt: at, diagnosticCode: rng.pick(['1', '3', '6']), ...stamp(vehicles, s.vehicleId, at, false) });
    push({ eventType: 7, eventCode: 4, at: cleared, recordedAt: cleared, diagnosticCode: '3', ...stamp(vehicles, s.vehicleId, cleared, false) });
  }
  if (longDrives.length && rng.chance(0.06)) {
    const s = rng.pick(longDrives);
    const at = s.start + 45 * M;
    const cleared = at + rng.int(60, 240) * M;
    const code = rng.pick(['L', 'P', 'T', 'E']);
    push({ eventType: 7, eventCode: 1, at, recordedAt: at, malfunctionCode: code, ...stamp(vehicles, s.vehicleId, at, false) });
    push({ eventType: 7, eventCode: 2, at: cleared, recordedAt: cleared, malfunctionCode: code, ...stamp(vehicles, s.vehicleId, cleared, false) });
  }

  const vehicleAt = (t: number): string | null => {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    return n ? segments[lo].vehicleId : null;
  };

  // §9.3 driver self-edits (D-019 append-only shapes, `planDriverSelfEdit`).
  const appliedEdits: EditPlan[] = [];
  for (const edit of input.edits) {
    if (edit.editedAt > now) continue;
    const common = {
      at: edit.start,
      recordedAt: edit.editedAt,
      recordOrigin: 2,
      vehicleId: vehicleAt(edit.start),
      annotation: edit.annotation.slice(0, 60),
      editedById: driverId,
      editorType: 'DRIVER' as const,
      editReason: edit.annotation,
      phase: 2 as const,
    };
    if (edit.kind === 'INSERT_OFF') {
      push({ ...common, eventType: 1, eventCode: DUTY_CODE.OFF });
    } else if (edit.kind === 'RELABEL_SB') {
      const target = dutyAt.get(edit.start);
      if (!target || target.code !== DUTY_CODE.OFF) continue;
      push({ ...common, eventType: 1, eventCode: target.code, recordStatus: 2, supersedesUuid: target.uuid });
      push({ ...common, eventType: 1, eventCode: DUTY_CODE.SB, supersedesUuid: target.uuid });
    } else if (edit.kind === 'ADD_ON' && edit.end !== null && edit.restore) {
      push({ ...common, eventType: 1, eventCode: DUTY_CODE.ON });
      push({ ...common, at: edit.end, eventType: 1, eventCode: DUTY_CODE[edit.restore] });
    } else {
      continue;
    }
    appliedEdits.push(edit);
  }

  // §9.2 certifications.
  const certs = input.planCerts(logins, appliedEdits);
  for (const cert of certs) {
    for (const ev of cert.events) {
      push({
        eventType: 4,
        eventCode: Math.min(9, ev.code),
        at: ev.at,
        recordedAt: ev.at,
        recordOrigin: 2,
        vehicleId: vehicleAt(ev.at),
        annotation: `Certified RODS day ${cert.date}`,
        comment: `certifiedDate=${cert.date}`,
        editedById: driverId,
        editorType: 'DRIVER',
      });
    }
  }

  return { rows: finalize(drafts, timezone, now), appliedEdits, certs };
}

/** Unidentified driving on a vehicle (recordOrigin 4, no driver) — §7.4 rule 3. */
export function buildUnidentifiedEvents(
  vehicle: VehicleCtx,
  episodes: Array<{ start: number; end: number }>,
  timezone: string,
  now: number,
): EventRow[] {
  const drafts: Draft[] = [];
  let order = 0;
  const push = (fields: Partial<Draft> & { eventType: number; eventCode: number; at: number }): void => {
    order += 1;
    drafts.push({
      ...blankDraft(),
      recordOrigin: 4,
      ...stamp(new Map([[vehicle.id, vehicle]]), vehicle.id, fields.at, false),
      ...fields,
      recordedAt: fields.at,
      uuid: mockUuid(`${vehicle.id}:unidentified:${order}`),
      order,
    } as Draft);
  };
  for (const ep of episodes) {
    push({ eventType: 6, eventCode: 1, at: ep.start - M });
    push({ eventType: 1, eventCode: DUTY_CODE.D, at: ep.start });
    for (let t = ep.start + H; t < ep.end; t += H) push({ eventType: 2, eventCode: 1, at: t });
    push({ eventType: 1, eventCode: DUTY_CODE.ON, at: ep.end });
    push({ eventType: 6, eventCode: 3, at: ep.end + 2 * M });
  }
  return finalize(drafts, timezone, now);
}

/** Idle gaps on a vehicle where somebody moved it without logging in. */
export function pickUnidentifiedEpisodes(
  rng: MockRng,
  busy: Array<[number, number]>,
  from: number,
  to: number,
  count: number,
): Array<{ start: number; end: number }> {
  const gaps: Array<[number, number]> = [];
  let last = from;
  for (const [s, e] of busy) {
    if (s - last >= 6 * H) gaps.push([last + 2 * H, s - 2 * H]);
    last = Math.max(last, e);
  }
  if (to - last >= 6 * H) gaps.push([last + 2 * H, to - 2 * H]);
  const out: Array<{ start: number; end: number }> = [];
  for (const [s, e] of rng.shuffle(gaps).slice(0, count)) {
    const dur = rng.int(12, 75) * M;
    if (e - s < dur + 10 * M) continue;
    const start = Math.floor((s + rng.float(0, e - s - dur)) / M) * M;
    out.push({ start, end: start + dur });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** §9.2 — which past days the driver certified, and when (at the next login after the day). */
export function planCertifications(
  rng: MockRng,
  timezone: string,
  keys: string[],
  logins: number[],
  edits: EditPlan[],
  now: number,
): CertDay[] {
  const out: CertDay[] = [];
  for (const key of keys) {
    const dayStartMs = fastDayStart(timezone, key);
    const dayEndMs = fastDayStart(timezone, addDays(key, 1));
    if (dayEndMs > now) continue;
    const age = (now - dayEndMs) / DAY;
    const p = age > 3 ? 0.93 : age > 1 ? 0.6 : 0.3;
    if (!rng.chance(p)) continue;

    let lo = 0;
    let hi = logins.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (logins[mid] < dayEndMs) lo = mid + 1;
      else hi = mid;
    }
    let at = lo < logins.length && logins[lo] - dayEndMs < 5 * DAY ? logins[lo] + rng.int(1, 4) * M : dayEndMs + rng.float(1, 14) * H;
    at = Math.round(at / 1000) * 1000;
    if (at > now) continue;

    const events = [{ at, code: 1 }];
    let certified = true;
    const late = edits.filter((e) => e.start >= dayStartMs && e.start < dayEndMs && e.editedAt > at && e.editedAt <= now);
    if (late.length) {
      const lastEdit = Math.max(...late.map((e) => e.editedAt));
      const again = Math.round((lastEdit + rng.float(0.5, 20) * H) / 1000) * 1000;
      if (rng.chance(0.7) && again <= now) events.push({ at: again, code: 2 });
      else certified = false;
    }
    out.push({ date: key, certified, certifiedAt: events[events.length - 1].at, count: events.length, events });
  }
  return out;
}
