/**
 * Location precision coarsening (TZ §23 compliance checklist).
 * On-duty positions are recorded to 1 mile; Personal Conveyance to 10 miles,
 * and the coarsening happens BEFORE storage.
 */
import { kmToMi, kmToMiUnrounded } from './convert';

const MI_PER_DEG_LAT = 69.0;

export type LocationPrecision = 'ONE_MILE' | 'TEN_MILE';

export interface Coordinates {
  lat: number;
  lon: number;
}

/** Rounds a coordinate pair to the given precision bucket. */
export function coarsenLocation(coords: Coordinates, precision: LocationPrecision): Coordinates {
  const miles = precision === 'TEN_MILE' ? 10 : 1;
  const latStep = miles / MI_PER_DEG_LAT;
  const cosLat = Math.cos((coords.lat * Math.PI) / 180);
  const lonStep = latStep / (Math.abs(cosLat) < 1e-6 ? 1e-6 : Math.abs(cosLat));
  return {
    lat: Math.round(coords.lat / latStep) * latStep,
    lon: Math.round(coords.lon / lonStep) * lonStep,
  };
}

/** Great-circle distance in miles between two points (haversine). */
export function distanceMi(a: Coordinates, b: Coordinates): number {
  return kmToMi(haversineKm(a, b));
}

/** Great-circle distance in UNROUNDED miles — geo-location lookups (Appendix A §4.4.2) only. */
export function greatCircleMi(a: Coordinates, b: Coordinates): number {
  return kmToMiUnrounded(haversineKm(a, b));
}

function haversineKm(a: Coordinates, b: Coordinates): number {
  const R_KM = 6371.0088;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
