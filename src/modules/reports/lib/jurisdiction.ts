/**
 * TZ §15 / §5.10 "IFTA va yoqilg'i" — maps a lat/lon telemetry point to an IFTA jurisdiction
 * (US state or Canadian province two-letter code).
 *
 * No geocoding integration exists in this project (TZ §16 lists only Pacific Track, Firebase,
 * McLeod, WEX/Comdata, QuickBooks, Slack, generic webhooks — no reverse-geocoder). Building
 * one is out of Phase 8's scope, so jurisdiction is resolved with an axis-aligned bounding-box
 * table per state/province (public, approximate — see D-041 in decisions.md). Overlaps at
 * shared borders are resolved by table order (first match wins, ordered so smaller/enclosed
 * boxes are checked first where they matter, e.g. DC before MD/VA).
 */
export interface JurisdictionBox {
  code: string;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

// Approximate bounding boxes, contiguous US + DC + the Canadian provinces IFTA covers.
// Alaska/Hawaii are non-contiguous and excluded from IFTA (no cross-jurisdiction driving).
export const JURISDICTION_BOXES: JurisdictionBox[] = [
  { code: 'DC', minLat: 38.79, maxLat: 39.0, minLon: -77.12, maxLon: -76.91 },
  { code: 'CT', minLat: 40.95, maxLat: 42.05, minLon: -73.73, maxLon: -71.78 },
  { code: 'RI', minLat: 41.15, maxLat: 42.02, minLon: -71.91, maxLon: -71.12 },
  { code: 'NJ', minLat: 38.93, maxLat: 41.36, minLon: -75.56, maxLon: -73.89 },
  { code: 'NH', minLat: 42.7, maxLat: 45.31, minLon: -72.56, maxLon: -70.61 },
  { code: 'VT', minLat: 42.73, maxLat: 45.02, minLon: -73.44, maxLon: -71.46 },
  { code: 'MA', minLat: 41.24, maxLat: 42.89, minLon: -73.51, maxLon: -69.86 },
  { code: 'MD', minLat: 37.91, maxLat: 39.72, minLon: -79.49, maxLon: -75.05 },
  { code: 'DE', minLat: 38.45, maxLat: 39.84, minLon: -75.79, maxLon: -75.05 },
  { code: 'WV', minLat: 37.2, maxLat: 40.64, minLon: -82.65, maxLon: -77.72 },
  { code: 'SC', minLat: 32.03, maxLat: 35.22, minLon: -83.35, maxLon: -78.54 },
  { code: 'ME', minLat: 42.98, maxLat: 47.46, minLon: -71.08, maxLon: -66.95 },
  { code: 'IN', minLat: 37.77, maxLat: 41.76, minLon: -88.1, maxLon: -84.78 },
  { code: 'KY', minLat: 36.5, maxLat: 39.15, minLon: -89.57, maxLon: -81.96 },
  { code: 'TN', minLat: 34.98, maxLat: 36.68, minLon: -90.31, maxLon: -81.65 },
  { code: 'VA', minLat: 36.54, maxLat: 39.47, minLon: -83.68, maxLon: -75.24 },
  { code: 'NY', minLat: 40.5, maxLat: 45.02, minLon: -79.76, maxLon: -71.86 },
  { code: 'PA', minLat: 39.72, maxLat: 42.27, minLon: -80.52, maxLon: -74.69 },
  { code: 'OH', minLat: 38.4, maxLat: 42.32, minLon: -84.82, maxLon: -80.52 },
  { code: 'MI', minLat: 41.7, maxLat: 48.31, minLon: -90.42, maxLon: -82.41 },
  { code: 'WI', minLat: 42.49, maxLat: 47.31, minLon: -92.89, maxLon: -86.25 },
  { code: 'IL', minLat: 36.97, maxLat: 42.51, minLon: -91.51, maxLon: -87.02 },
  { code: 'GA', minLat: 30.36, maxLat: 35.0, minLon: -85.61, maxLon: -80.84 },
  { code: 'FL', minLat: 24.4, maxLat: 31.0, minLon: -87.63, maxLon: -80.03 },
  { code: 'AL', minLat: 30.14, maxLat: 35.01, minLon: -88.47, maxLon: -84.89 },
  { code: 'MS', minLat: 30.17, maxLat: 35.0, minLon: -91.66, maxLon: -88.1 },
  { code: 'NC', minLat: 33.75, maxLat: 36.59, minLon: -84.32, maxLon: -75.4 },
  { code: 'MN', minLat: 43.5, maxLat: 49.38, minLon: -97.24, maxLon: -89.49 },
  { code: 'IA', minLat: 40.38, maxLat: 43.5, minLon: -96.64, maxLon: -90.14 },
  { code: 'MO', minLat: 35.99, maxLat: 40.61, minLon: -95.77, maxLon: -89.1 },
  { code: 'AR', minLat: 33.0, maxLat: 36.5, minLon: -94.62, maxLon: -89.64 },
  { code: 'LA', minLat: 28.93, maxLat: 33.02, minLon: -94.04, maxLon: -88.82 },
  { code: 'TX', minLat: 25.84, maxLat: 36.5, minLon: -106.65, maxLon: -93.51 },
  { code: 'OK', minLat: 33.62, maxLat: 37.0, minLon: -103.0, maxLon: -94.43 },
  { code: 'KS', minLat: 36.99, maxLat: 40.0, minLon: -102.05, maxLon: -94.59 },
  { code: 'NE', minLat: 40.0, maxLat: 43.0, minLon: -104.05, maxLon: -95.31 },
  { code: 'SD', minLat: 42.48, maxLat: 45.94, minLon: -104.06, maxLon: -96.44 },
  { code: 'ND', minLat: 45.94, maxLat: 49.0, minLon: -104.05, maxLon: -96.55 },
  { code: 'MT', minLat: 44.36, maxLat: 49.0, minLon: -116.05, maxLon: -104.04 },
  { code: 'WY', minLat: 40.99, maxLat: 45.01, minLon: -111.06, maxLon: -104.05 },
  { code: 'CO', minLat: 37.0, maxLat: 41.0, minLon: -109.06, maxLon: -102.04 },
  { code: 'NM', minLat: 31.33, maxLat: 37.0, minLon: -109.05, maxLon: -103.0 },
  { code: 'AZ', minLat: 31.33, maxLat: 37.0, minLon: -114.82, maxLon: -109.04 },
  { code: 'UT', minLat: 37.0, maxLat: 42.0, minLon: -114.05, maxLon: -109.04 },
  { code: 'ID', minLat: 41.99, maxLat: 49.0, minLon: -117.24, maxLon: -111.04 },
  { code: 'NV', minLat: 35.0, maxLat: 42.0, minLon: -120.0, maxLon: -114.04 },
  { code: 'CA', minLat: 32.53, maxLat: 42.01, minLon: -124.41, maxLon: -114.13 },
  { code: 'OR', minLat: 41.99, maxLat: 46.29, minLon: -124.57, maxLon: -116.46 },
  { code: 'WA', minLat: 45.54, maxLat: 49.0, minLon: -124.73, maxLon: -116.92 },
  // Canada (IFTA member provinces).
  { code: 'ON', minLat: 41.68, maxLat: 56.86, minLon: -95.16, maxLon: -74.34 },
  { code: 'QC', minLat: 44.99, maxLat: 62.58, minLon: -79.76, maxLon: -57.1 },
  { code: 'NB', minLat: 44.6, maxLat: 48.07, minLon: -69.05, maxLon: -63.77 },
  { code: 'NS', minLat: 43.4, maxLat: 47.04, minLon: -66.4, maxLon: -59.68 },
  { code: 'MB', minLat: 48.99, maxLat: 60.0, minLon: -102.05, maxLon: -88.97 },
  { code: 'SK', minLat: 48.99, maxLat: 60.0, minLon: -110.0, maxLon: -101.36 },
  { code: 'AB', minLat: 48.99, maxLat: 60.0, minLon: -120.0, maxLon: -110.0 },
  { code: 'BC', minLat: 48.3, maxLat: 60.0, minLon: -139.06, maxLon: -114.05 },
  { code: 'PE', minLat: 45.94, maxLat: 47.07, minLon: -64.42, maxLon: -61.97 },
];

/** Returns the jurisdiction code for a point, or `null` if it falls outside every box
 * (open water, a gap in the approximation, or a non-IFTA jurisdiction). */
export function jurisdictionFor(latitude: number, longitude: number): string | null {
  for (const box of JURISDICTION_BOXES) {
    if (latitude >= box.minLat && latitude <= box.maxLat && longitude >= box.minLon && longitude <= box.maxLon) {
      return box.code;
    }
  }
  return null;
}

/** Great-circle distance in miles — used when consecutive telemetry points lack a reliable
 * `odometerMi` delta (device restart, GPS-only fix, or a decreasing odometer glitch). */
export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R_MI = 3958.7613;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R_MI * c;
}
