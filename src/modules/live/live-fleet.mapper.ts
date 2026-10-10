/**
 * `GET /live/fleet` (web/tz.md §20 B-3) — one row per vehicle for W-01's map preview and W-02
 * Live Fleet. Pure on purpose: every rule deciding what the panel shows is here and unit-tested
 * without Prisma. The shape mirrors `web/src/shared/api/liveFleet.ts#LiveFleetUnit` exactly.
 *
 * Coordinates are passed through as stored: both `TelemetryPoint` and `EldEvent` are already
 * coarsened at ingest (1 mi / 10 mi under PC, §7.3 rule 9), so nothing here can leak a raw fix.
 */
import type { DutyStatus as HosDutyStatus } from '../hos/hos.types';

/** The web's `DutyStatus` union (`web/src/shared/ui/Badge.tsx`). */
export type LiveDutyStatus =
  | 'DRIVING'
  | 'ON_DUTY'
  | 'SLEEPER'
  | 'OFF_DUTY'
  | 'YARD_MOVE'
  | 'PERSONAL_CONVEYANCE'
  | 'ELD_OFFLINE'
  | 'IDLE'
  | 'INACTIVE';

export interface LiveFleetUnit {
  vehicleId: string;
  unitNumber: string;
  driverId: string | null;
  driverName: string | null;
  driverPhone: string | null;
  dutyStatus: LiveDutyStatus;
  speedMph: number | null;
  headingDeg: number | null;
  odometerMi: number | null;
  lat: number | null;
  lon: number | null;
  locationLabel: string | null;
  lastSeenAt: string | null;
  driveRemainingSec: number | null;
  shiftEndsAt: string | null;
  eldSerial: string | null;
  bleState: 'CONNECTED' | 'DISCONNECTED' | null;
}

export interface LiveFleetResponse {
  items: LiveFleetUnit[];
  generatedAt: string;
}

/** §7 hard rule — "over 30 min unconnected -> alert.eld_disconnected"; the panel uses the same line. */
export const ELD_OFFLINE_AFTER_MS = 30 * 60 * 1000;
/** A telemetry fix older than this no longer says anything about the truck's current speed. */
export const SPEED_FRESH_MS = 30 * 60 * 1000;

export interface LatestTelemetry {
  time: Date;
  /** Time of the latest point WITH a GPS fix (may be older than `time`); null = never located. */
  fixTime: Date | null;
  latitude: number | null;
  longitude: number | null;
  speedMph: number | null;
  headingDeg: number | null;
  odometerMi: number | null;
  engineOn: boolean | null;
}

export interface LatestLocatedEvent {
  eventDateTime: Date;
  latitude: number;
  longitude: number;
  locationName: string | null;
}

export interface LiveFleetInput {
  vehicle: { id: string; unitNumber: string; status: string; odometerMi: number };
  driver: { id: string; firstName: string; lastName: string; phone: string | null } | null;
  device: { serial: string; bleState: string; lastSeenAt: Date | null } | null;
  telemetry: LatestTelemetry | null;
  located: LatestLocatedEvent | null;
  hos: { currentStatus: HosDutyStatus; driveRemainingSec: number; shiftEndsAt: Date | null } | null;
  /** Active PC/YM indication (eventType 3) newer than the last duty-status record, if any. */
  special: 'PC' | 'YM' | null;
  now: Date;
}

const DUTY_BY_HOS: Record<HosDutyStatus, LiveDutyStatus> = {
  D: 'DRIVING',
  ON: 'ON_DUTY',
  SB: 'SLEEPER',
  OFF: 'OFF_DUTY',
};

function latest(dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && (!best || d.getTime() > best.getTime())) best = d;
  return best;
}

export function isEldOffline(device: LiveFleetInput['device'], now: Date): boolean {
  if (!device) return false;
  if (!device.lastSeenAt) return true;
  return now.getTime() - device.lastSeenAt.getTime() > ELD_OFFLINE_AFTER_MS;
}

export function resolveDutyStatus(input: LiveFleetInput, telemetryFresh: boolean): LiveDutyStatus {
  const { driver, hos, device, special, telemetry, vehicle, now } = input;
  if (driver && hos) {
    if (special === 'PC' && hos.currentStatus === 'OFF') return 'PERSONAL_CONVEYANCE';
    if (special === 'YM' && hos.currentStatus === 'ON') return 'YARD_MOVE';
    if (hos.currentStatus === 'ON' && telemetryFresh && telemetry?.engineOn === true && telemetry.speedMph === 0) {
      return 'IDLE';
    }
    return DUTY_BY_HOS[hos.currentStatus];
  }
  // Nobody is signed in to this truck: the only thing worth saying is whether its ELD is alive.
  if (device && isEldOffline(device, now)) return 'ELD_OFFLINE';
  return vehicle.status === 'ACTIVE' && device ? 'OFF_DUTY' : 'INACTIVE';
}

export function toLiveFleetUnit(input: LiveFleetInput): LiveFleetUnit {
  const { vehicle, driver, device, telemetry, located, hos, now } = input;
  const telemetryFresh = !!telemetry && now.getTime() - telemetry.time.getTime() <= SPEED_FRESH_MS;

  // Position: whichever source is newer — a telemetry fix or a located RODS record. A telemetry
  // point without a GPS fix (PT SDK 6.11) is not a position; its latest located point is.
  const fix =
    telemetry && telemetry.fixTime && telemetry.latitude !== null && telemetry.longitude !== null
      ? { at: telemetry.fixTime, lat: telemetry.latitude, lon: telemetry.longitude }
      : null;
  const useEvent = !!located && (!fix || located.eventDateTime.getTime() > fix.at.getTime());
  const position = useEvent
    ? { lat: located.latitude, lon: located.longitude }
    : fix
      ? { lat: fix.lat, lon: fix.lon }
      : { lat: null, lon: null };
  // A place name only describes the fix when it is the fix, or within the freshness window of it.
  const labelMatches =
    !!located &&
    (useEvent || (fix !== null && Math.abs(fix.at.getTime() - located.eventDateTime.getTime()) <= SPEED_FRESH_MS));

  const offline = isEldOffline(device, now);
  const lastSeen = latest([device?.lastSeenAt, telemetry?.time, located?.eventDateTime]);

  return {
    vehicleId: vehicle.id,
    unitNumber: vehicle.unitNumber,
    driverId: driver?.id ?? null,
    driverName: driver ? `${driver.firstName} ${driver.lastName}`.trim() : null,
    driverPhone: driver?.phone ?? null,
    dutyStatus: resolveDutyStatus(input, telemetryFresh),
    speedMph: telemetryFresh ? (telemetry.speedMph ?? null) : null,
    headingDeg: telemetry?.headingDeg ?? null,
    odometerMi: telemetry?.odometerMi ?? vehicle.odometerMi ?? null,
    lat: position.lat,
    lon: position.lon,
    locationLabel: labelMatches ? (located.locationName ?? null) : null,
    lastSeenAt: lastSeen ? lastSeen.toISOString() : null,
    driveRemainingSec: driver && hos ? hos.driveRemainingSec : null,
    shiftEndsAt: driver && hos?.shiftEndsAt ? hos.shiftEndsAt.toISOString() : null,
    eldSerial: device?.serial ?? null,
    bleState: device ? (!offline && device.bleState === 'CONNECTED' ? 'CONNECTED' : 'DISCONNECTED') : null,
  };
}

/** Natural unit order (`#9` before `#10`), the order both W-01 and W-02 list units in. */
export function compareUnitNumbers(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}
