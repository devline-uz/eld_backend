/**
 * 49 CFR 395 Subpart B Appendix A §4.4.2 / §7.29 — automatic geo-location ("location description").
 *
 * Converts a (already coarsened) latitude/longitude into
 *   `<distance>mi <direction> <State> <Place>`   e.g. `2mi ESE IL Darien`, `11mi NNW IN West Lafayette`
 * using an OFFLINE place database (GeoNames cities1000, US/CA/MX — see `data/places-na.tsv`).
 *
 * Rules (mirrored for the mobile app in `docs/location-description.md`):
 * - reference place = the nearest place in the database (great-circle distance);
 * - distance = whole miles, max two digits (§7.29) — farther than 99 mi -> no description;
 * - direction = 16-point compass bearing FROM the place TO the position (§7.29 / Table 10);
 * - distance rounding to 0 -> distance and direction are left blank: `<State> <Place>`;
 * - reduced precision (personal conveyance, §4.7.3) -> distance rounded to 10 mi, max 90;
 * - overall text <= 60 characters (the place name is truncated).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { greatCircleMi } from '../units';

export interface GeoPlace {
  name: string;
  /** Appendix A Table 5 two-letter State/Province abbreviation. */
  state: string;
  lat: number;
  lon: number;
}

export interface NearestPlace {
  place: GeoPlace;
  distanceMi: number;
}

export interface DescribeOptions {
  /** §4.7.3 personal conveyance — the position carries 10-mile precision only. */
  reducedPrecision?: boolean;
}

/** Appendix A Table 10 — the 16 compass points, clockwise from north. */
export const COMPASS_16 = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
] as const;

export const GEO_LOCATION_MAX_LENGTH = 60;
/** §7.29 — the distance is "<C> or <CC>": 0..99 whole miles. */
export const MAX_DISTANCE_MI = 99;
export const CELL_DEG = 0.5;
/** Conservative (low) miles per degree of latitude, so search boxes always contain the circle. */
const MI_PER_DEG_LOW = 68.7;
const SEARCH_RADII_MI = [15, 40, 100] as const;

export const PLACES_DATA_FILE = join(__dirname, 'data', 'places-na.tsv');

/** Initial great-circle bearing from `from` to `to`, degrees clockwise from true north, [0, 360). */
export function bearingDeg(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const phi1 = rad(from.lat);
  const phi2 = rad(to.lat);
  const dLambda = rad(to.lon - from.lon);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Bearing -> one of the 16 Table 10 directions (each sector 22.5 deg wide, centred on its point). */
export function compass16(bearing: number): (typeof COMPASS_16)[number] {
  const normalized = ((bearing % 360) + 360) % 360;
  return COMPASS_16[Math.round(normalized / 22.5) % 16];
}

/** Formats the §7.29 text; `null` when the distance cannot be expressed in two digits. */
export function formatGeoLocation(
  place: GeoPlace,
  distance: number,
  bearing: number,
  options: DescribeOptions = {},
): string | null {
  const step = options.reducedPrecision ? 10 : 1;
  const miles = Math.round(distance / step) * step;
  if (miles > MAX_DISTANCE_MI) return null;
  const head = miles === 0 ? `${place.state} ` : `${miles}mi ${compass16(bearing)} ${place.state} `;
  const room = GEO_LOCATION_MAX_LENGTH - head.length;
  return `${head}${place.name.slice(0, room)}`.trimEnd();
}

/** Uniform lat/lon grid (0.5 deg cells), built once; nearest-place lookups touch a few cells only. */
export class PlaceIndex {
  private readonly cells = new Map<number, GeoPlace[]>();
  readonly size: number;

  constructor(places: readonly GeoPlace[]) {
    for (const place of places) {
      const key = cellKey(cellRow(place.lat), cellCol(place.lon));
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(place);
      else this.cells.set(key, [place]);
    }
    this.size = places.length;
  }

  /** Nearest place within `maxMi` (great-circle), or `null`. Ties -> first by name, then state. */
  nearest(lat: number, lon: number, maxMi = MAX_DISTANCE_MI + 0.5): NearestPlace | null {
    for (const radius of SEARCH_RADII_MI) {
      const r = Math.min(radius, maxMi);
      const best = this.bestInBox(lat, lon, r);
      if (best && best.distanceMi <= r) return best;
      if (r >= maxMi) return null;
    }
    return null;
  }

  private bestInBox(lat: number, lon: number, radiusMi: number): NearestPlace | null {
    const dLat = radiusMi / MI_PER_DEG_LOW;
    const latEdge = Math.min(89.9, Math.abs(lat) + dLat);
    const dLon = Math.min(180, radiusMi / (MI_PER_DEG_LOW * Math.cos((latEdge * Math.PI) / 180)));
    let best: NearestPlace | null = null;
    for (let row = cellRow(lat - dLat); row <= cellRow(lat + dLat); row += 1) {
      for (let col = cellCol(lon - dLon); col <= cellCol(lon + dLon); col += 1) {
        for (const place of this.cells.get(cellKey(row, col)) ?? []) {
          const d = greatCircleMi({ lat, lon }, place);
          if (!best || d < best.distanceMi || (d === best.distanceMi && comparePlaces(place, best.place) < 0)) {
            best = { place, distanceMi: d };
          }
        }
      }
    }
    return best;
  }
}

function cellRow(lat: number): number {
  return Math.floor((lat + 90) / CELL_DEG);
}
function cellCol(lon: number): number {
  return Math.floor((lon + 180) / CELL_DEG);
}
function cellKey(row: number, col: number): number {
  return row * 10_000 + col;
}
function comparePlaces(a: GeoPlace, b: GeoPlace): number {
  return a.name.localeCompare(b.name) || a.state.localeCompare(b.state);
}

/** Parses the TSV built by `scripts/build-geo-places.mjs` (`#` lines are comments). */
export function parsePlaces(text: string): GeoPlace[] {
  const places: GeoPlace[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [name, state, lat, lon] = line.split('\t');
    const latN = Number(lat);
    const lonN = Number(lon);
    if (!name || !state || !Number.isFinite(latN) || !Number.isFinite(lonN)) continue;
    places.push({ name, state, lat: latN, lon: lonN });
  }
  return places;
}

let defaultIndex: PlaceIndex | null = null;

/** The process-wide index, loaded from `data/places-na.tsv` on first use (warmed at startup). */
export function getPlaceIndex(): PlaceIndex {
  defaultIndex ??= new PlaceIndex(parsePlaces(readFileSync(PLACES_DATA_FILE, 'utf8')));
  return defaultIndex;
}

/** Number-like input (number, numeric string, Prisma `Decimal`) -> finite number or `null`. */
function toCoordinate(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** §4.4.2 — the geo-location text for a position, or `null` (no/invalid position, nothing within 99 mi). */
export function describeLocation(
  lat: unknown,
  lon: unknown,
  options: DescribeOptions = {},
  index: PlaceIndex = getPlaceIndex(),
): string | null {
  const latN = toCoordinate(lat);
  const lonN = toCoordinate(lon);
  if (latN === null || lonN === null || Math.abs(latN) > 90 || Math.abs(lonN) > 180) return null;
  const maxMi = options.reducedPrecision ? 95 : MAX_DISTANCE_MI + 0.5;
  const hit = index.nearest(latN, lonN, maxMi);
  if (!hit) return null;
  return formatGeoLocation(hit.place, hit.distanceMi, bearingDeg(hit.place, { lat: latN, lon: lonN }), options);
}

/**
 * The location text a record stores: a non-blank text supplied by the app/driver ALWAYS wins
 * (stored exactly as sent); otherwise the computed geo-location when there is a position.
 */
export function resolveLocationText(
  supplied: string | null | undefined,
  lat: unknown,
  lon: unknown,
  options: DescribeOptions = {},
): string | null {
  if (typeof supplied === 'string' && supplied.trim() !== '') return supplied;
  return describeLocation(lat, lon, options);
}

/** The stored-record shape a read-time fallback needs (EldEvent / Dvir columns, structurally). */
export interface LocatedRecord {
  locationName?: string | null;
  latitude?: unknown;
  longitude?: unknown;
  /** EldEvent: 10 = personal-conveyance precision (§4.7.3). */
  locationPrecisionMi?: number | null;
}

/**
 * Read-time `locationDescription`: the stored text, or — for rows written before the geo-location
 * service existed — the text computed from the stored (already coarsened) position.
 */
export function locationTextOf(record: LocatedRecord | null | undefined): string | null {
  if (!record) return null;
  return resolveLocationText(record.locationName, record.latitude, record.longitude, {
    reducedPrecision: (record.locationPrecisionMi ?? 1) >= 10,
  });
}
