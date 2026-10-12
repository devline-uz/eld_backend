import { z } from 'zod';
import { VIRTUAL_SERIAL_PATTERN } from '../../carrier/virtual-eld.policy';

/** IEEE EUI-48 as `AA:BB:CC:DD:EE:FF`, `aa-bb-cc-dd-ee-ff` or `AABBCCDDEEFF` (one separator style). */
const MAC_RE = /^[0-9A-Fa-f]{2}([:-]?)[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}$/;
const NOT_A_DEVICE_MAC = new Set(['00:00:00:00:00:00', 'FF:FF:FF:FF:FF:FF']);

/** Any MAC spelling -> canonical upper-case colon form; `null` when it is not an EUI-48. */
export function normalizeMac(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  if (!MAC_RE.test(text)) return null;
  const hex = text.replace(/[:-]/g, '').toUpperCase();
  return hex.match(/.{2}/g)!.join(':');
}

/**
 * MG-BLE-1/2 — `POST /mobile/device/mac`. The app REPORTS the BLE MAC it observed on the PT30 bound
 * to the driver's selected unit; it never pairs or re-binds a device (back-office only).
 */
export const ReportDeviceMacDto = z.object({
  deviceId: z.string().uuid(),
  macAddress: z
    .string()
    .trim()
    .transform((value, ctx) => {
      const mac = normalizeMac(value);
      if (!mac || NOT_A_DEVICE_MAC.has(mac)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'macAddress must be a BLE MAC like AA:BB:CC:DD:EE:FF.' });
        return z.NEVER;
      }
      return mac;
    }),
});
export type ReportDeviceMacDto = z.infer<typeof ReportDeviceMacDto>;

/** PT SDK 6.11 — `GET /mobile/device-config?serial=`. */
export const DeviceConfigQueryDto = z.object({
  serial: z.string().trim().min(1).max(60),
});
export type DeviceConfigQueryDto = z.infer<typeof DeviceConfigQueryDto>;

/**
 * pt30_pt40/tz.md §9.3 — `POST /mobile/virtual-devices`. `serial` must match §9.1
 * (`^VPT(30|40)_[A-Z0-9]{4,12}$`, upper-cased first) and its `PT30`/`PT40` part must equal `model`.
 */
export const RegisterVirtualDeviceDto = z
  .object({
    serial: z.string().trim().toUpperCase().regex(VIRTUAL_SERIAL_PATTERN, 'serial must look like VPT30_A1B2 / VPT40_A1B2 (^VPT(30|40)_[A-Z0-9]{4,12}$).'),
    model: z.enum(['PT30', 'PT40']),
    firmware: z.string().trim().min(1).max(20).optional(),
    vin: z.string().trim().min(1).max(20).optional(),
  })
  .refine((dto) => dto.serial.slice(1, 5) === dto.model, {
    message: 'model must match the serial (VPT30_… -> PT30, VPT40_… -> PT40).',
    path: ['model'],
  });
export type RegisterVirtualDeviceDto = z.infer<typeof RegisterVirtualDeviceDto>;
