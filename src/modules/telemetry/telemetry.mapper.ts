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
  latitude: number;
  longitude: number;
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
  const coords = coarsenLocation(
    { lat: point.latitude, lon: point.longitude },
    ctx.pcActive ? 'TEN_MILE' : 'ONE_MILE',
  );

  return {
    time: point.time,
    vehicleId: ctx.vehicleId,
    driverId: ctx.driverId,
    latitude: coords.lat,
    longitude: coords.lon,
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
  };
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
