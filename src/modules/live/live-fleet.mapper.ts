/**
 * `GET /live/fleet` (web/tz.md §20 B-3) — one row per vehicle for W-01's map preview and W-02
 * Live Fleet. Pure on purpose: every rule deciding what the panel shows is here and unit-tested
 * without Prisma. The shape mirrors `web/src/shared/api/liveFleet.ts#LiveFleetUnit` exactly.
 *
 * Coordinates are passed through as stored: both `TelemetryPoint` and `EldEvent` are already
 * coarsened at ingest (1 mi / 10 mi under PC, §7.3 rule 9), so nothing here can leak a raw fix.
 */
import { describeLocation, resolveLocationText } from '../../common/geo-location/location-description';
import { staleStatusCapAt } from '../drivers/lib/stale-status';
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

/** UI-004 — the stored `Vehicle.status` (the record), independent of what the ELD reports. */
export type LiveRecordStatus = 'ACTIVE' | 'INACTIVE' | 'OUT_OF_SERVICE';

/** UI-004 — whether the unit's ELD is talking to us at all. */
export type LiveConnectivity = 'NO_DEVICE' | 'ELD_OFFLINE' | 'ONLINE';

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
  /**
   * Place text describing the marker (`lat`/`lon`): the RODS event's locationName when the marker
   * comes from that event, else the offline geo-location of the telemetry fix (`4mi SSE TX Addison`).
   */
  locationLabel: string | null;
  lastSeenAt: string | null;
  driveRemainingSec: number | null;
  shiftEndsAt: string | null;
  eldSerial: string | null;
  bleState: 'CONNECTED' | 'DISCONNECTED' | null;
  /** UI-004 — `Vehicle.status`; OUT_OF_SERVICE / INACTIVE units read `dutyStatus: 'INACTIVE'`. */
  recordStatus: LiveRecordStatus;
  /** UI-004 — NO_DEVICE (no ELD paired), ELD_OFFLINE (silent > 30 min) or ONLINE. */
  connectivity: LiveConnectivity;
  /**
   * UI-003 — the driver's HOS duty status is NOT live: either it is past its plausibility cap
   * (BUG-002) or a DRIVING / ON-DUTY unit's ELD went silent. `dutyStatus` then reads ELD_OFFLINE.
   */
  isStale: boolean;
  /** UI-003 — the cap instant (BUG-002) or the last signal heard from the unit; null when unknown / not stale. */
  staleSince: string | null;
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
  hos: { currentStatus: HosDutyStatus; statusSince?: Date; driveRemainingSec: number; shiftEndsAt: Date | null } | null;
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

function recordStatusOf(status: string): LiveRecordStatus {
  return status === 'OUT_OF_SERVICE' || status === 'INACTIVE' ? status : 'ACTIVE';
}

export function resolveConnectivity(device: LiveFleetInput['device'], now: Date): LiveConnectivity {
  if (!device) return 'NO_DEVICE';
  return isEldOffline(device, now) ? 'ELD_OFFLINE' : 'ONLINE';
}

/**
 * UI-003 — when the assigned driver's duty status cannot be trusted as live:
 * - BUG-002: the status is past its plausibility cap (16 h D / 24 h ON), whatever the device says;
 * - a DRIVING / ON-DUTY unit whose ELD is silent (> 30 min), or a DRIVING unit that has sent no
 *   telemetry for 30 min (a moving truck reports continuously; an on-duty one may sit engine-off).
 * OFF / SB are kept as they are (a parked truck legitimately goes quiet); `connectivity` still
 * says the ELD is offline. A unit without a device has nothing to go silent.
 */
export function resolveStaleness(input: LiveFleetInput, telemetryFresh: boolean): { isStale: boolean; staleSince: Date | null } {
  const { driver, hos, device, telemetry, now } = input;
  if (!driver || !hos) return { isStale: false, staleSince: null };
  const capAt = hos.statusSince ? staleStatusCapAt(hos.currentStatus, hos.statusSince, now) : null;
  if (capAt) return { isStale: true, staleSince: capAt };
  const active = hos.currentStatus === 'D' || hos.currentStatus === 'ON';
  if (active && device && (isEldOffline(device, now) || (hos.currentStatus === 'D' && !telemetryFresh))) {
    return { isStale: true, staleSince: latest([device.lastSeenAt, telemetry?.time]) };
  }
  return { isStale: false, staleSince: null };
}

export function resolveDutyStatus(input: LiveFleetInput, telemetryFresh: boolean): LiveDutyStatus {
  const { driver, hos, device, special, telemetry, vehicle, now } = input;
  // UI-004 — the record wins: an out-of-service or deactivated truck is not on the road.
  if (recordStatusOf(vehicle.status) !== 'ACTIVE') return 'INACTIVE';
  if (driver && hos) {
    if (resolveStaleness(input, telemetryFresh).isStale) return 'ELD_OFFLINE';
    if (special === 'PC' && hos.currentStatus === 'OFF') return 'PERSONAL_CONVEYANCE';
    if (special === 'YM' && hos.currentStatus === 'ON') return 'YARD_MOVE';
    if (hos.currentStatus === 'ON' && telemetryFresh && telemetry?.engineOn === true && telemetry.speedMph === 0) {
      return 'IDLE';
    }
    return DUTY_BY_HOS[hos.currentStatus];
  }
  // Nobody is signed in to this truck: the only thing worth saying is whether its ELD is alive.
  if (device && isEldOffline(device, now)) return 'ELD_OFFLINE';
  return device ? 'OFF_DUTY' : 'INACTIVE';
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
  // The label must describe the marker. Position from a RODS event -> that event's stored
  // locationName (computed from its coordinates when blank); position from a telemetry fix -> the
  // same offline geo-location ingest uses, computed from the fix (never an older event's name).
  // PC (§4.7.3): ingest already coarsened the stored coordinates to 10 mi, so describe at 10 mi too.
  const reducedPrecision = input.special === 'PC';
  const locationLabel = useEvent
    ? resolveLocationText(located.locationName, located.latitude, located.longitude, { reducedPrecision })
    : fix
      ? describeLocation(fix.lat, fix.lon, { reducedPrecision })
      : null;

  const offline = isEldOffline(device, now);
  const recordStatus = recordStatusOf(vehicle.status);
  const stale = recordStatus === 'ACTIVE' ? resolveStaleness(input, telemetryFresh) : { isStale: false, staleSince: null };
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
    locationLabel,
    lastSeenAt: lastSeen ? lastSeen.toISOString() : null,
    driveRemainingSec: driver && hos ? hos.driveRemainingSec : null,
    shiftEndsAt: driver && hos?.shiftEndsAt ? hos.shiftEndsAt.toISOString() : null,
    eldSerial: device?.serial ?? null,
    bleState: device ? (!offline && device.bleState === 'CONNECTED' ? 'CONNECTED' : 'DISCONNECTED') : null,
    recordStatus,
    connectivity: resolveConnectivity(device, now),
    isStale: stale.isStale,
    staleSince: stale.staleSince ? stale.staleSince.toISOString() : null,
  };
}

/** Natural unit order (`#9` before `#10`), the order both W-01 and W-02 list units in. */
export function compareUnitNumbers(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}
