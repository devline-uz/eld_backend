import type { Device } from '@prisma/client';

/**
 * §20 B-8 — `GET /devices/:id/diagnostics`. Shape taken from the frontend type
 * (`src/shared/api/settingsAdmin.ts#DeviceDiagnostics`): `{ signalStrength, gpsLock, responded }`.
 * Derived from the latest device status/BLE data already recorded by ingest (`Device.bleState`,
 * `Device.lastSeenAt`) — never a live round-trip to the device. A device that has gone quiet is
 * `responded: false`, not an HTTP error: an unresponsive ELD is itself the diagnosis.
 */
export interface DeviceDiagnostics {
  signalStrength: 'good' | 'fair' | 'poor';
  gpsLock: boolean;
  responded: boolean;
}

/** A device that hasn't reported in this long is treated as unresponsive. */
const RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
/** Within this window of `lastSeenAt`, a CONNECTED device reads as 'good' signal; older -> 'fair'. */
const FRESH_WINDOW_MS = 2 * 60 * 1000;

export function deriveDeviceDiagnostics(device: Pick<Device, 'bleState' | 'lastSeenAt'>, now: Date = new Date()): DeviceDiagnostics {
  const lastSeen = device.lastSeenAt;
  const responded = Boolean(lastSeen) && device.bleState !== 'DISCONNECTED' && now.getTime() - lastSeen!.getTime() <= RESPONSE_TIMEOUT_MS;

  if (!responded) {
    return { signalStrength: 'poor', gpsLock: false, responded: false };
  }

  const ageMs = now.getTime() - lastSeen!.getTime();
  const signalStrength: DeviceDiagnostics['signalStrength'] =
    device.bleState === 'CONNECTED' ? (ageMs <= FRESH_WINDOW_MS ? 'good' : 'fair') : 'poor';
  const gpsLock = device.bleState === 'CONNECTED';

  return { signalStrength, gpsLock, responded: true };
}
