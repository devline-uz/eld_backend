/**
 * Web DISPLAY normaliser for stored location texts (D-127 follow-up).
 *
 * Stored `locationName` values reach the web in more than one shape: the §395 Appendix A §7.29
 * text the backend computes (`2mi SSE OH Riverside`, `KY Florence`) and free-form
 * "N mi DIR of City, ST" / "City, ST" texts written by older writers and seed data
 * (`2 mi E of Richmond, IN`, `Gary, IN`). The canonical form in this repo is §7.29
 * (`docs/location-description.md`, D-127), so the web shows every recognisable text in it:
 *
 *   `2 mi E of Richmond, IN`  -> `2mi E IN Richmond`
 *   `0.64 mi N of Florence, KY` -> `1mi N KY Florence`
 *   `Gary, IN`                -> `IN Gary`
 *   `2mi sse oh  Riverside`   -> `2mi SSE OH Riverside`
 *   `<1mi E KY Florence`, `0mi E KY Florence` -> `KY Florence`
 *
 * Anything it cannot parse safely (e.g. `Teston, Vaughan, Canada`, free text, > 99 mi) is
 * returned unchanged. DISPLAY ONLY: never write the result back, and never use it in a
 * compliance export (ELD output file / DOT transfer / FMCSA CSV keep the recorded text).
 */
import { COMPASS_16, GEO_LOCATION_MAX_LENGTH, MAX_DISTANCE_MI, type DescribeOptions, type LocatedRecord, locationTextOf } from './location-description';

/** Appendix A Table 5 codes the place database uses (US, CA, MX). */
const STATE_CODES = new Set([
  'AB', 'AG', 'AK', 'AL', 'AR', 'AZ', 'BC', 'BN', 'BS', 'CA', 'CH', 'CI', 'CL', 'CO', 'CP', 'CS', 'CT',
  'DC', 'DE', 'DF', 'DG', 'FL', 'GA', 'GE', 'GJ', 'HD', 'HI', 'IA', 'ID', 'IL', 'IN', 'JA', 'KS', 'KY',
  'LA', 'MA', 'MB', 'MC', 'MD', 'ME', 'MI', 'MN', 'MO', 'MR', 'MS', 'MT', 'MX', 'NA', 'NB', 'NC', 'ND',
  'NE', 'NH', 'NJ', 'NL', 'NM', 'NS', 'NT', 'NU', 'NV', 'NY', 'OA', 'OH', 'OK', 'ON', 'OR', 'PA', 'PE',
  'PU', 'QC', 'QE', 'QI', 'RI', 'SC', 'SD', 'SI', 'SK', 'SL', 'SO', 'TA', 'TB', 'TL', 'TN', 'TX', 'UT',
  'VA', 'VC', 'VT', 'WA', 'WI', 'WV', 'WY', 'YT', 'YU', 'ZA',
]);
const DIRECTIONS = new Set<string>(COMPASS_16);

const DISTANCE = String.raw`(<\s*)?(\d{1,3}(?:\.\d+)?)\s*mi\.?`;
/** `2mi SSE OH Riverside`, `2 mi sse oh Riverside`, `<1mi E KY Florence` (§7.29 shape). */
const DEVICE_RE = new RegExp(String.raw`^${DISTANCE}\s+([A-Za-z]{1,3})\s+([A-Za-z]{2})\s+(\S.*)$`, 'i');
/** `2 mi E of Richmond, IN`, `0.64 mi N of Florence, KY`. */
const OF_RE = new RegExp(String.raw`^${DISTANCE}\s+([A-Za-z]{1,3})\s+of\s+([^,]+?)\s*,\s*([A-Za-z]{2})$`, 'i');
/** `KY Florence` — already canonical, distance blank (state must be upper case). */
const BARE_RE = /^([A-Z]{2})\s+(\S.*)$/;
/** `Gary, IN` — one place name, then the state (upper case). */
const CITY_STATE_RE = /^([^,]+?)\s*,\s*([A-Z]{2})$/;

function compose(miles: number, direction: string, state: string, place: string): string {
  const head = miles === 0 ? `${state} ` : `${miles}mi ${direction} ${state} `;
  return `${head}${place.slice(0, GEO_LOCATION_MAX_LENGTH - head.length)}`.trimEnd();
}

function fromParts(lessThan: boolean, distance: string, dir: string, state: string, place: string, options: DescribeOptions): string | null {
  const direction = dir.toUpperCase();
  const st = state.toUpperCase();
  if (!DIRECTIONS.has(direction) || !STATE_CODES.has(st)) return null;
  const step = options.reducedPrecision ? 10 : 1;
  const miles = lessThan ? 0 : Math.round(Number(distance) / step) * step;
  if (!Number.isFinite(miles) || miles > MAX_DISTANCE_MI) return null;
  return compose(miles, direction, st, place);
}

/**
 * The §7.29 display form of a stored location text; unparseable input is returned unchanged.
 * `reducedPrecision` (PC, §4.7.3) rounds the distance to 10 mi, so a display never shows more
 * precision than the record may carry.
 */
export function normalizeLocationText(text: string, options?: DescribeOptions): string;
export function normalizeLocationText(text: string | null | undefined, options?: DescribeOptions): string | null;
export function normalizeLocationText(text: string | null | undefined, options: DescribeOptions = {}): string | null {
  if (typeof text !== 'string') return null;
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean === '') return text;

  const of = OF_RE.exec(clean);
  if (of) return fromParts(Boolean(of[1]), of[2], of[3], of[5], of[4], options) ?? text;

  const device = DEVICE_RE.exec(clean);
  if (device) return fromParts(Boolean(device[1]), device[2], device[3], device[4], device[5], options) ?? text;

  const bare = BARE_RE.exec(clean);
  if (bare && STATE_CODES.has(bare[1])) return compose(0, '', bare[1], bare[2]);

  const cityState = CITY_STATE_RE.exec(clean);
  if (cityState && STATE_CODES.has(cityState[2])) return compose(0, '', cityState[2], cityState[1]);

  return text;
}

/** Web read-time location text of a record: `locationTextOf`, then the display normaliser. */
export function displayLocationTextOf(record: LocatedRecord | null | undefined): string | null {
  return normalizeLocationText(locationTextOf(record), {
    reducedPrecision: (record?.locationPrecisionMi ?? 1) >= 10,
  });
}
