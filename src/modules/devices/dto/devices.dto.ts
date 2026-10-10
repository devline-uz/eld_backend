import { z } from 'zod';

export const DeviceModelEnum = z.enum(['PT30', 'PT40']);
export const DeviceStatusEnum = z.enum(['UNASSIGNED', 'ASSIGNED', 'FAULTY', 'RETIRED']);
export const BleStateEnum = z.enum(['CONNECTED', 'OUT_OF_RANGE', 'DISCONNECTED']);

/** TZ §5.4 — PT30/PT40 registry ("Settings > ELD devices" Figma screen: registered devices,
 * firmware, heartbeats). */
export const CreateDeviceDto = z.object({
  serial: z.string().min(1).max(60),
  bleMacAddress: z.string().max(30).optional(),
  model: DeviceModelEnum.default('PT30'),
  firmware: z.string().max(20).optional(),
  periodicConnectedSec: z.number().int().min(2).max(7200).default(30),
  /** LEGACY (minutes) — superseded by `periodicNoBleSec`; kept for backwards compatibility. */
  periodicDisconnectedMin: z.number().int().min(1).max(480).default(30),
  /** PT SDK `PERIODIC_EVENT_GAP_NOBLE`, seconds 10–480. */
  periodicNoBleSec: z.number().int().min(10).max(480).default(30),
  /** PT SDK `DRIVING_ACCL` / `DRIVING_BRAKING` / `DRIVING_CORNERING` thresholds, mG 0–8192
   * (0 = device harsh detection off). Pushed to the device by the app (D-135). */
  harshAccelMg: z.number().int().min(0).max(8192).default(0),
  harshBrakeMg: z.number().int().min(0).max(8192).default(0),
  harshCornerMg: z.number().int().min(0).max(8192).default(0),
  /** §20 B-88. */
  autoFirmware: z.boolean().default(true),
  shareDiagnostics: z.boolean().default(true),
});
export type CreateDeviceDto = z.infer<typeof CreateDeviceDto>;

export const UpdateDeviceDto = CreateDeviceDto.partial().extend({
  status: DeviceStatusEnum.optional(),
});
export type UpdateDeviceDto = z.infer<typeof UpdateDeviceDto>;

/** Device <-> vehicle binding lives only on `Device.vehicleId` (hard rule). */
export const PairDeviceDto = z.object({
  vehicleId: z.string().uuid(),
});
export type PairDeviceDto = z.infer<typeof PairDeviceDto>;

export const UpdateFirmwareDto = z.object({
  firmware: z.string().min(1).max(20),
});
export type UpdateFirmwareDto = z.infer<typeof UpdateFirmwareDto>;

/** TZ §5.4 — the app reports BLE connection state; never guessed server-side. */
export const UpdateBleStatusDto = z.object({
  bleState: BleStateEnum,
  storedEventsCount: z.number().int().min(0).optional(),
});
export type UpdateBleStatusDto = z.infer<typeof UpdateBleStatusDto>;

export const DeviceListQueryDto = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(60).optional(),
  q: z.string().max(200).optional(),
  status: DeviceStatusEnum.optional(),
  bleState: BleStateEnum.optional(),
  /** §20 B-35 — `GET /devices?vehicleId=` join so the web fleet table can resolve one unit's
   * device without pulling the whole registry (W-03 ELD SERIAL column, W-04 ELD device). */
  vehicleId: z.string().uuid().optional(),
});
export type DeviceListQueryDto = z.infer<typeof DeviceListQueryDto>;

export const ImportDevicesDto = z.object({
  devices: z.array(CreateDeviceDto).min(1).max(1000),
});
export type ImportDevicesDto = z.infer<typeof ImportDevicesDto>;
