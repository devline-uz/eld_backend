import {
  applyOdometerOffsetMi,
  coarsenLocation,
  kmToMi,
  kmhToMph,
  kmplToMpg,
  kpaToPsi,
  lToGal,
  lphToGph,
} from '../../common/units';
import type { TelemetryPointDto } from '../ingest/dto/ingest.dto';

/**
 * TZ §4.2 + §5.6 — the PT30 reports metric, the DB stores imperial, and the conversion happens
 * here (backend) rather than in the two Flutter apps. TZ §7.3 rule 9 applies to telemetry too:
 * the coordinate is coarsened BEFORE storage and the raw one is never persisted.
 */

export interface TelemetryRow {
  time: Date;
  vehicleId: string;
  driverId: string | null;
  /** `null` when the point carried no GPS fix (SDK 6.11 VDB snapshot without lock). */
  latitude: number | null;
  longitude: number | null;
  speedMph: number | null;
  headingDeg: number | null;
  odometerMi: number | null;
  engineHours: number | null;
  idleHours: number | null;
  ptoHours: number | null;
  engineOn: boolean | null;
  rpm: number | null;
  gear: string | null;
  seatBelt: boolean | null;
  loadPct: number | null;
  fuelPct: number | null;
  fuelPct2: number | null;
  defPct: number | null;
  fuelRateGph: number | null;
  fuelEconomyMpg: number | null;
  totalFuelUsedGal: number | null;
  totalFuelIdleGal: number | null;
  oilPressurePsi: number | null;
  oilPct: number | null;
  oilTempC: number | null;
  coolantPct: number | null;
  coolantTempC: number | null;
  intakeTempC: number | null;
  ambientTempC: number | null;
  transmOilTempC: number | null;
  dtcCount: number | null;
  busType: 'J1939' | 'J1708' | 'OBD_II' | null;
  voltage: number | null;
  intakePressureKpa: number | null;
  barometerKpa: number | null;
  fuelTempC: number | null;
  intercoolerTempC: number | null;
  turboOilTempC: number | null;
  retarderPct: number | null;
  brakePedal: number | null;
  odometerComputed: boolean | null;
  engineHoursComputed: boolean | null;
  gpsLocked: boolean | null;
  gpsSatellites: number | null;
  gpsDop: number | null;
  gpsAgeSec: number | null;
}

export interface TelemetryContext {
  vehicleId: string;
  driverId: string | null;
  /** §4.3 — `true = device + offset`. */
  odometerOffsetMi: number;
  /** §7.3 rule 9 — active Personal Conveyance coarsens the position to 10 miles. */
  pcActive: boolean;
}

const opt = <T>(value: T | null | undefined, map: (v: T) => number): number | null =>
  value === null || value === undefined ? null : map(value);

/** "Absent parameter is `null`, not an error" (§5.6 note) — every optional field passes through. */
export function toTelemetryRow(point: TelemetryPointDto, ctx: TelemetryContext): TelemetryRow {
  // A half pair is not a position: both coordinates or neither (SDK 6.11 points without a fix).
  const coords = hasPosition(point)
    ? coarsenLocation({ lat: point.latitude, lon: point.longitude }, ctx.pcActive ? 'TEN_MILE' : 'ONE_MILE')
    : null;

  return {
    time: point.time,
    vehicleId: ctx.vehicleId,
    driverId: ctx.driverId,
    latitude: coords?.lat ?? null,
    longitude: coords?.lon ?? null,
    speedMph: opt(point.speedKmh, kmhToMph),
    headingDeg: point.headingDeg ?? null,
    odometerMi: opt(point.odometerKm, (km) => applyOdometerOffsetMi(kmToMi(km), ctx.odometerOffsetMi)),
    engineHours: point.engineHours ?? null,
    idleHours: point.idleHours ?? null,
    ptoHours: point.ptoHours ?? null,
    engineOn: point.engineOn ?? null,
    rpm: point.rpm ?? null,
    gear: point.gear ?? null,
    seatBelt: point.seatBelt ?? null,
    loadPct: point.loadPct ?? null,
    fuelPct: point.fuelPct ?? null,
    fuelPct2: point.fuelPct2 ?? null,
    defPct: point.defPct ?? null,
    fuelRateGph: opt(point.fuelRateLph, lphToGph),
    fuelEconomyMpg: opt(point.fuelEconomyKmpl, kmplToMpg),
    totalFuelUsedGal: opt(point.totalFuelUsedL, lToGal),
    totalFuelIdleGal: opt(point.totalFuelIdleL, lToGal),
    oilPressurePsi: opt(point.oilPressureKpa, kpaToPsi),
    oilPct: point.oilPct ?? null,
    oilTempC: point.oilTempC ?? null,
    coolantPct: point.coolantPct ?? null,
    coolantTempC: point.coolantTempC ?? null,
    intakeTempC: point.intakeTempC ?? null,
    ambientTempC: point.ambientTempC ?? null,
    transmOilTempC: point.transmOilTempC ?? null,
    dtcCount: point.dtcCount ?? null,
    busType: point.busType ?? null,
    voltage: point.voltage ?? null,
    // SDK 6.11 additions — the columns are metric (kPa / °C), stored exactly as reported.
    intakePressureKpa: point.intakePressureKpa ?? null,
    barometerKpa: point.barometerKpa ?? null,
    fuelTempC: point.fuelTempC ?? null,
    intercoolerTempC: point.intercoolerTempC ?? null,
    turboOilTempC: point.turboOilTempC ?? null,
    retarderPct: point.retarderPct ?? null,
    brakePedal: point.brakePedal ?? null,
    odometerComputed: point.odometerComputed ?? null,
    engineHoursComputed: point.engineHoursComputed ?? null,
    gpsLocked: point.gpsLocked ?? null,
    gpsSatellites: point.gpsSatellites ?? null,
    gpsDop: point.gpsDop ?? null,
    gpsAgeSec: point.gpsAgeSec ?? null,
  };
}

/** Narrowing guard: the point carries a full coordinate pair. */
export function hasPosition<T extends { latitude?: number | null; longitude?: number | null }>(
  point: T,
): point is T & { latitude: number; longitude: number } {
  return (
    point.latitude !== null && point.latitude !== undefined && point.longitude !== null && point.longitude !== undefined
  );
}

/** §7.5 — the app downsamples to 1 point/60 s but NEVER drops a transition. */
export const TELEMETRY_MIN_INTERVAL_SEC = 60;

export interface DownsampleReport {
  kept: TelemetryPointDto[];
  /** Points that arrived closer together than 60 s and were not transitions. */
  dense: number;
}

/**
 * Server-side view of the app's downsampling contract. Nothing is ever dropped — dense points
 * are counted and reported so a misbehaving app build is visible — transitions are always kept.
 */
export function inspectDownsampling(points: TelemetryPointDto[]): DownsampleReport {
  const sorted = [...points].sort((a, b) => a.time.getTime() - b.time.getTime());
  let lastKept: number | null = null;
  let dense = 0;
  for (const point of sorted) {
    if (point.isTransition) continue;
    if (lastKept !== null && (point.time.getTime() - lastKept) / 1000 < TELEMETRY_MIN_INTERVAL_SEC) {
      dense += 1;
      continue;
    }
    lastKept = point.time.getTime();
  }
  return { kept: sorted, dense };
}
