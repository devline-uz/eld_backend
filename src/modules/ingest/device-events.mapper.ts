import type { Device, Prisma, SafetyEventType } from '@prisma/client';
import { coarsenLocation, kmhToMph } from '../../common/units';
import type { DeviceRawEventDto, DeviceRawEventTypeName } from './dto/ingest.dto';

/**
 * PT SDK 6.11 raw `TelemetryEvent` -> `DeviceRawEvent` row, and the device's own harsh-driving
 * detections (`EV_MEMS_ACC/BRK/COR`) -> `SafetyEvent`. Pure: unit-tested without Prisma.
 *
 * These are NOT §395 Appendix A records (the app still computes those and posts them to
 * `/ingest/events`); they are the raw device log. Coordinates are still coarsened before
 * storage (§7.3 rule 9 — raw coordinates are stored nowhere), speed stays km/h in the raw log
 * (metric, like `rawDeviceOdometerKm`) and is converted to mph only for `SafetyEvent`.
 */

export const HARSH_SAFETY_TYPE: Partial<Record<DeviceRawEventTypeName, SafetyEventType>> = {
  HARSH_ACCEL: 'HARSH_ACCEL',
  HARSH_BRAKE: 'HARSH_BRAKING',
  HARSH_CORNER: 'HARSH_TURN',
};

export function isHarshType(type: DeviceRawEventTypeName): boolean {
  return HARSH_SAFETY_TYPE[type] !== undefined;
}

/** The device threshold (mG) that produced a harsh event of this type. */
export function harshThresholdMg(
  type: DeviceRawEventTypeName,
  device: Pick<Device, 'harshAccelMg' | 'harshBrakeMg' | 'harshCornerMg'>,
): number {
  if (type === 'HARSH_ACCEL') return device.harshAccelMg;
  if (type === 'HARSH_BRAKE') return device.harshBrakeMg;
  if (type === 'HARSH_CORNER') return device.harshCornerMg;
  return 0;
}

/** Unknown threshold (0 = configured off, yet the device reported one) -> middle severity. */
export const HARSH_SEVERITY_UNKNOWN = 3;

/**
 * The SDK's MEMS events carry no magnitude — only "the configured threshold was crossed". The
 * threshold is therefore the best severity proxy we have (D-135): 1 per 150 mG, clamped 1–5
 * (150 mG -> 1, 300 -> 2, 450 -> 3, 600 -> 4, >= 750 -> 5).
 */
export function harshSeverity(thresholdMg: number): number {
  if (!thresholdMg || thresholdMg <= 0) return HARSH_SEVERITY_UNKNOWN;
  return Math.max(1, Math.min(5, Math.round(thresholdMg / 150)));
}

export interface RawEventContext {
  deviceId: string;
  vehicleId: string;
  /** Owner of this event: the uploader for live events, the §7.4 ladder for stored ones. */
  driverId: string | null;
  /** §7.3 rule 9 — active Personal Conveyance coarsens to 10 miles. */
  pcActive: boolean;
}

/** The SDK ACK key — also the in-payload dedupe key. */
export function rawEventKey(event: { occurredAt: Date; seq: number }): string {
  return `${event.occurredAt.getTime()}:${event.seq}`;
}

export function toRawEventRow(event: DeviceRawEventDto, ctx: RawEventContext): Prisma.DeviceRawEventCreateManyInput {
  const coords =
    event.latitude !== null && event.latitude !== undefined && event.longitude !== null && event.longitude !== undefined
      ? coarsenLocation({ lat: event.latitude, lon: event.longitude }, ctx.pcActive ? 'TEN_MILE' : 'ONE_MILE')
      : null;
  return {
    deviceId: ctx.deviceId,
    vehicleId: ctx.vehicleId,
    driverId: ctx.driverId,
    type: event.type,
    seq: event.seq,
    hsi: event.hsi ?? null,
    occurredAt: event.occurredAt,
    live: event.live,
    latitude: coords?.lat ?? null,
    longitude: coords?.lon ?? null,
    headingDeg: event.headingDeg ?? null,
    gpsLocked: event.gpsLocked ?? null,
    gpsSatellites: event.gpsSatellites ?? null,
    gpsDop: event.gpsDop ?? null,
    gpsAgeSec: event.gpsAgeSec ?? null,
    odometerKm: event.odometerKm ?? null,
    speedKmh: event.speedKmh === null || event.speedKmh === undefined ? null : Math.round(event.speedKmh),
    engineHours: event.engineHours ?? null,
    rpm: event.rpm ?? null,
    obd2: event.obd2 ?? null,
    engineAgeSec: event.engineAgeSec ?? null,
  };
}

/** A newly stored harsh raw event -> `SafetyEvent` (coarsened position, mph). */
export function toSafetyEventRow(
  row: Prisma.DeviceRawEventCreateManyInput,
  device: Pick<Device, 'harshAccelMg' | 'harshBrakeMg' | 'harshCornerMg'>,
): Prisma.SafetyEventCreateManyInput | null {
  const type = HARSH_SAFETY_TYPE[row.type];
  if (!type) return null;
  const thresholdMg = harshThresholdMg(row.type, device);
  return {
    driverId: row.driverId ?? null,
    vehicleId: row.vehicleId as string,
    type,
    occurredAt: row.occurredAt,
    severity: harshSeverity(thresholdMg),
    speedMph: row.speedKmh === null || row.speedKmh === undefined ? null : kmhToMph(row.speedKmh),
    // The event fired at (at least) the configured threshold; 0 = unknown.
    gForce: thresholdMg > 0 ? Math.round(thresholdMg / 10) / 100 : null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
  };
}
