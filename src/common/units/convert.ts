/**
 * TZ §4.2 — metric ↔ imperial conversion.
 *
 * The PT30 reports everything metric; the DB stores imperial (mile, gallon, mph, psi)
 * because FMCSA / IFTA / the DOT output file require those units.
 *
 * This file is the ONLY place in the codebase allowed to convert units.
 * Rounding behaviour is normative — do not "improve" it: the values here end up in
 * §395 records and must stay reproducible.
 */

/** Exact ratios, TZ §4.2. */
export const KM_TO_MI = 0.621371;
export const L_TO_GAL = 0.264172;
export const KPA_TO_PSI = 0.145038;

const MI_TO_KM = 1 / KM_TO_MI;
const GAL_TO_L = 1 / L_TO_GAL;
const PSI_TO_KPA = 1 / KPA_TO_PSI;

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Kilometres → whole miles (odometer, trip distance). TZ §4.2. */
export const kmToMi = (km: number): number => Math.round(km * KM_TO_MI);

/** Kilometres → UNROUNDED miles — geometry only (nearest-place search), never a stored value. */
export const kmToMiUnrounded = (km: number): number => km * KM_TO_MI;

/** km/h → whole mph (speed is never stored fractionally). TZ §4.2. */
export const kmhToMph = (kmh: number): number => Math.round(kmh * KM_TO_MI);

/** Litres → gallons, 2 decimals (fuel volume, IFTA). TZ §4.2. */
export const lToGal = (l: number): number => round(l * L_TO_GAL, 2);

/** kPa → psi, 1 decimal (tyre / oil pressure). TZ §4.2. */
export const kpaToPsi = (kpa: number): number => round(kpa * KPA_TO_PSI, 1);

/** L/h → gal/h, 2 decimals (fuel rate). */
export const lphToGph = (lph: number): number => round(lph * L_TO_GAL, 2);

/** km/L → mpg, 1 decimal (fuel economy). */
export const kmplToMpg = (kmpl: number): number => round(kmpl * KM_TO_MI * GAL_TO_L, 1);

/** Inverse companions — used when echoing imperial input back to a metric device/report. */
export const miToKm = (mi: number): number => round(mi * MI_TO_KM, 3);
export const mphToKmh = (mph: number): number => round(mph * MI_TO_KM, 3);
export const galToL = (gal: number): number => round(gal * GAL_TO_L, 3);
export const psiToKpa = (psi: number): number => round(psi * PSI_TO_KPA, 1);

/**
 * Celsius stays Celsius (TZ §4.1) — this identity function exists so callers never
 * hand-roll a temperature conversion "just in case".
 */
export const celsiusToCelsius = (c: number): number => c;
