import { createHash } from 'node:crypto';
import type { Device, DeviceModel } from '@prisma/client';

/**
 * PT SDK 6.11 system variables the app writes to the device (`SetSystemVar`). The server is the
 * source of truth (back office edits them on `PATCH /devices/:id`); the app reads them from
 * `GET /mobile/device-config` and from every `POST /ingest/device-status` answer and applies
 * whatever differs from what the device reports (D-135).
 *
 * `EVENTS_STORED` is always 1 — the device must buffer events while BLE is down (§7.4 relies on
 * `wasStoredOnDevice`), and `HSI_MODE` stays at the SDK default 1.
 */
export interface DeviceSystemVars {
  /** Seconds, 2–7200 (`Device.periodicConnectedSec`). */
  PERIODIC_EVENT_GAP: number;
  /** Seconds, 10–480 (`Device.periodicNoBleSec`). */
  PERIODIC_EVENT_GAP_NOBLE: number;
  EVENTS_STORED: 1;
  /** mG, 0–8192, 0 = device harsh detection off. */
  DRIVING_ACCL: number;
  DRIVING_BRAKING: number;
  DRIVING_CORNERING: number;
  HSI_MODE: 1;
}

export type SystemVarSource = Pick<
  Device,
  'periodicConnectedSec' | 'periodicNoBleSec' | 'harshAccelMg' | 'harshBrakeMg' | 'harshCornerMg'
>;

export function buildSystemVars(device: SystemVarSource): DeviceSystemVars {
  return {
    PERIODIC_EVENT_GAP: device.periodicConnectedSec,
    PERIODIC_EVENT_GAP_NOBLE: device.periodicNoBleSec,
    EVENTS_STORED: 1,
    DRIVING_ACCL: device.harshAccelMg,
    DRIVING_BRAKING: device.harshBrakeMg,
    DRIVING_CORNERING: device.harshCornerMg,
    HSI_MODE: 1,
  };
}

/**
 * Stable short fingerprint of the config the app applies. `Device` has no `updatedAt` column, so
 * the app compares this instead of a timestamp to know whether it must re-apply (D-135).
 */
export function configVersion(device: SystemVarSource & Pick<Device, 'autoFirmware' | 'shareDiagnostics'>): string {
  const vars = buildSystemVars(device);
  const canonical = JSON.stringify([
    ...Object.keys(vars)
      .sort()
      .map((k) => [k, vars[k as keyof DeviceSystemVars]]),
    ['autoFirmware', device.autoFirmware],
    ['shareDiagnostics', device.shareDiagnostics],
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/** `TrackerInfo.productName` (`PT30`, `PT40-C`, `pt40`) -> `DeviceModel`; `null` when unknown. */
export function modelFromProductName(productName: string | null | undefined): DeviceModel | null {
  const name = (productName ?? '').trim().toUpperCase();
  if (name.startsWith('PT40')) return 'PT40';
  if (name.startsWith('PT30')) return 'PT30';
  return null;
}

/** VINs compared case-insensitively, ignoring whitespace. Empty on either side = no verdict. */
export function isVinMismatch(reported: string | null | undefined, onRecord: string | null | undefined): boolean {
  const a = (reported ?? '').replace(/\s+/g, '').toUpperCase();
  const b = (onRecord ?? '').replace(/\s+/g, '').toUpperCase();
  if (!a || !b) return false;
  return a !== b;
}
