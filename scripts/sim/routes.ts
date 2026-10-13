/**
 * Driver simulator — US interstate polylines (compact `[lat, lon]` waypoints, roughly one per
 * major interchange / city on the corridor) and the geometry to move a truck along them.
 *
 * Coordinates are approximate (±1-2 mi) and intentionally coarse: the server coarsens every
 * stored position to 1 mile anyway (§7.3 rule 9). Straight lines between waypoints are good
 * enough for a live-map demo.
 */

export type LatLon = readonly [number, number];

export interface SimRoute {
  id: string;
  name: string;
  points: readonly LatLon[];
}

export const ROUTES: readonly SimRoute[] = [
  {
    id: 'I80',
    name: 'I-80 San Francisco - Chicago',
    points: [
      [37.8, -122.37], [38.1, -122.25], [38.25, -122.04], [38.55, -121.74], [38.6, -121.45],
      [38.9, -121.07], [39.33, -120.18], [39.53, -119.81], [39.61, -119.25], [40.18, -118.47],
      [40.97, -117.73], [40.64, -116.93], [40.83, -115.76], [41.11, -114.96], [40.74, -114.07],
      [40.76, -111.95], [40.73, -111.55], [41.27, -110.96], [41.53, -109.47], [41.59, -109.2],
      [41.79, -107.24], [41.31, -105.59], [41.14, -104.82], [41.14, -102.98], [41.13, -101.72],
      [41.12, -100.77], [40.7, -99.08], [40.86, -98.38], [40.87, -97.59], [40.83, -96.7],
      [41.23, -96.02], [41.26, -95.85], [41.6, -93.62], [41.66, -91.53], [41.58, -90.58],
      [41.52, -88.08], [41.58, -87.35],
    ],
  },
  {
    id: 'I40',
    name: 'I-40 Barstow - Raleigh',
    points: [
      [34.9, -117.02], [34.84, -114.61], [35.19, -114.05], [35.19, -111.65], [35.02, -110.7],
      [34.9, -110.16], [35.53, -108.74], [35.15, -107.85], [35.08, -106.65], [34.94, -104.68],
      [35.17, -103.72], [35.19, -101.83], [35.22, -100.25], [35.41, -99.4], [35.47, -97.52],
      [35.43, -96.3], [35.44, -94.35], [35.28, -93.13], [34.75, -92.27], [35.01, -90.79],
      [35.15, -90.05], [35.61, -88.81], [36.16, -86.78], [36.16, -85.5], [35.96, -83.92],
      [35.6, -82.55], [35.73, -81.34], [36.1, -80.24], [36.07, -79.79], [35.78, -78.64],
    ],
  },
  {
    id: 'I10',
    name: 'I-10 Los Angeles - Jacksonville',
    points: [
      [34.05, -118.24], [34.06, -117.65], [33.93, -116.88], [33.83, -116.55], [33.72, -116.22],
      [33.61, -114.6], [33.66, -114.23], [33.45, -112.07], [32.88, -111.75], [32.22, -110.97],
      [31.97, -110.29], [32.35, -108.71], [32.27, -107.76], [32.31, -106.78], [31.76, -106.49],
      [31.04, -104.83], [30.89, -102.88], [30.71, -101.2], [30.49, -99.77], [30.05, -99.14],
      [29.42, -98.49], [29.57, -97.96], [29.71, -96.54], [29.76, -95.37], [30.08, -94.13],
      [30.23, -93.22], [30.22, -92.02], [30.45, -91.15], [29.95, -90.07], [30.37, -89.09],
      [30.69, -88.04], [30.47, -87.21], [30.44, -84.28], [30.19, -82.64], [30.33, -81.66],
    ],
  },
  {
    id: 'I95',
    name: 'I-95 Miami - Boston',
    points: [
      [25.77, -80.19], [26.12, -80.14], [26.71, -80.05], [27.27, -80.35], [28.08, -80.61],
      [29.21, -81.02], [30.33, -81.66], [31.15, -81.49], [32.08, -81.09], [33.0, -80.6],
      [34.2, -79.76], [35.05, -78.88], [35.94, -77.79], [37.23, -77.4], [37.54, -77.44],
      [38.3, -77.46], [38.8, -77.17], [39.29, -76.61], [39.74, -75.55], [39.95, -75.17],
      [40.22, -74.76], [40.73, -74.17], [41.05, -73.54], [41.31, -72.92], [41.36, -72.1],
      [41.82, -71.41], [42.36, -71.06],
    ],
  },
  {
    id: 'I35',
    name: 'I-35 Laredo - Duluth',
    points: [
      [27.51, -99.51], [28.44, -99.24], [29.42, -98.49], [29.7, -98.12], [30.27, -97.74],
      [31.1, -97.34], [31.55, -97.15], [32.01, -97.13], [32.75, -97.33], [33.21, -97.13],
      [33.63, -97.13], [34.17, -97.13], [35.47, -97.52], [36.29, -97.29], [37.69, -97.34],
      [38.4, -96.18], [39.1, -94.58], [40.27, -94.03], [41.6, -93.62], [42.03, -93.62],
      [43.14, -93.38], [43.65, -93.37], [44.08, -93.23], [44.98, -93.27], [46.79, -92.1],
    ],
  },
  {
    id: 'I70',
    name: 'I-70 Denver - Baltimore',
    points: [
      [39.74, -104.99], [39.26, -103.69], [39.3, -102.27], [39.4, -101.05], [38.88, -99.33],
      [38.84, -97.61], [38.92, -97.21], [39.05, -95.68], [39.1, -94.58], [38.95, -92.33],
      [38.63, -90.2], [39.12, -88.54], [39.47, -87.41], [39.77, -86.16], [39.83, -84.89],
      [39.86, -84.19], [39.96, -83.0], [39.94, -82.01], [40.06, -80.72], [40.17, -80.25],
      [40.0, -78.24], [39.64, -77.72], [39.41, -77.41], [39.29, -76.61],
    ],
  },
  {
    id: 'I75',
    name: 'I-75 Detroit - Naples',
    points: [
      [42.33, -83.05], [41.65, -83.54], [41.04, -83.65], [40.74, -84.11], [39.76, -84.19],
      [39.1, -84.51], [38.04, -84.5], [37.13, -84.08], [35.96, -83.92], [35.05, -85.31],
      [34.77, -84.97], [33.75, -84.39], [32.84, -83.63], [31.45, -83.51], [30.83, -83.28],
      [30.19, -82.64], [29.65, -82.32], [29.19, -82.14], [28.0, -82.3], [26.64, -81.87],
      [26.14, -81.79],
    ],
  },
  {
    id: 'I5',
    name: 'I-5 Seattle - Los Angeles',
    points: [
      [47.61, -122.33], [47.25, -122.44], [47.04, -122.9], [46.72, -122.95], [46.15, -122.91],
      [45.52, -122.68], [44.94, -123.04], [44.05, -123.09], [43.22, -123.34], [42.44, -123.33],
      [42.33, -122.87], [41.74, -122.63], [40.59, -122.39], [40.18, -122.24], [39.15, -122.15],
      [38.58, -121.49], [37.96, -121.29], [37.1, -121.01], [36.01, -119.96], [34.94, -118.92],
      [34.39, -118.54], [34.05, -118.24],
    ],
  },
  {
    id: 'I20',
    name: 'I-20 Dallas - Florence',
    points: [
      [32.78, -96.8], [32.5, -95.3], [32.5, -94.74], [32.52, -93.75], [32.51, -92.12],
      [32.35, -90.88], [32.3, -90.18], [32.36, -88.7], [33.52, -86.8], [33.66, -85.83],
      [33.75, -84.39], [33.47, -81.97], [34.0, -81.03], [34.2, -79.76],
    ],
  },
  {
    id: 'I81',
    name: 'I-81 Knoxville - Syracuse',
    points: [
      [36.07, -83.4], [36.55, -82.56], [36.71, -81.98], [37.13, -80.4], [37.27, -79.94],
      [38.15, -79.07], [38.45, -78.87], [39.19, -78.16], [39.64, -77.72], [40.2, -77.19],
      [40.27, -76.88], [40.6, -76.0], [41.25, -75.85], [41.4, -75.66], [42.1, -75.91],
      [42.6, -76.18], [43.05, -76.15],
    ],
  },
];

const EARTH_RADIUS_MI = 3958.7613;

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in miles. */
export function haversineMi(a: LatLon, b: LatLon): number {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing a -> b, integer degrees 0..359. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return Math.round((deg + 360) % 360) % 360;
}

/** Cumulative distance (mi) at every waypoint; last entry = route length. */
const cumulativeCache = new Map<string, number[]>();
export function cumulativeMi(route: SimRoute): number[] {
  const cached = cumulativeCache.get(route.id);
  if (cached) return cached;
  const cum = [0];
  for (let i = 1; i < route.points.length; i++) {
    cum.push(cum[i - 1] + haversineMi(route.points[i - 1], route.points[i]));
  }
  cumulativeCache.set(route.id, cum);
  return cum;
}

export function routeLengthMi(route: SimRoute): number {
  const cum = cumulativeMi(route);
  return cum[cum.length - 1];
}

export function findRoute(id: string): SimRoute {
  const route = ROUTES.find((r) => r.id === id);
  if (!route) throw new Error(`Unknown sim route "${id}"`);
  return route;
}

export interface RoutePosition {
  lat: number;
  lon: number;
  /** Heading of travel in the given direction. */
  headingDeg: number;
}

/**
 * Position at `distMi` from the route START, travelling in `dir` (+1 start->end, -1 end->start).
 * Linear interpolation between waypoints (fine at these spacings).
 */
export function positionAt(route: SimRoute, distMi: number, dir: 1 | -1): RoutePosition {
  const cum = cumulativeMi(route);
  const total = cum[cum.length - 1];
  const d = Math.max(0, Math.min(total, distMi));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const a = route.points[i - 1];
  const b = route.points[i];
  const seg = cum[i] - cum[i - 1] || 1;
  const f = (d - cum[i - 1]) / seg;
  const lat = a[0] + (b[0] - a[0]) * f;
  const lon = a[1] + (b[1] - a[1]) * f;
  const headingDeg = dir === 1 ? bearingDeg(a, b) : bearingDeg(b, a);
  return { lat, lon, headingDeg };
}

/**
 * Advances `distMi` by `deltaMi` in `dir`, bouncing at both ends (the truck turns around at the
 * end of the corridor). Returns the new distance and direction.
 */
export function advance(route: SimRoute, distMi: number, dir: 1 | -1, deltaMi: number): { distMi: number; dir: 1 | -1 } {
  const total = routeLengthMi(route);
  let d = distMi + dir * deltaMi;
  let nd: 1 | -1 = dir;
  // At most a couple of bounces even for silly deltas.
  for (let guard = 0; guard < 4; guard++) {
    if (d > total) {
      d = total - (d - total);
      nd = -1;
    } else if (d < 0) {
      d = -d;
      nd = 1;
    } else break;
  }
  return { distMi: Math.max(0, Math.min(total, d)), dir: nd };
}
