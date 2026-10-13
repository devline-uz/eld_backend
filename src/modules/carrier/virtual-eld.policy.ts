import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { AppConfigService } from '../../core/config/config.service';
import { CarrierRepository } from './carrier.repository';

/** pt30_pt40/tz.md §9.1 — the only serial shape a PT Emulator ("Virtual ELD") may use. */
export const VIRTUAL_SERIAL_PATTERN = /^VPT(30|40)_[A-Z0-9]{4,12}$/;

/**
 * §9.1 — every serial starting with `V` is reserved for the emulator, so `POST /devices` /
 * `POST /devices/import` refuse it (422 `VIRTUAL_SERIAL_RESERVED`). Case-insensitive: the
 * registry search is case-insensitive too, and `v…` must not slip a fake past the rule.
 */
export function isReservedVirtualSerial(serial: string): boolean {
  return /^v/i.test(serial.trim());
}

/** A device counts as virtual by flag OR by its reserved serial (pre-migration rows, D-142). */
export function isVirtualDevice(device: { isVirtual?: boolean | null; serial: string }): boolean {
  return device.isVirtual === true || isReservedVirtualSerial(device.serial);
}

/** What the switch resolves to: env permission AND the carrier flag. */
export function resolveVirtualEldEnabled(
  allowed: boolean,
  carrier: { virtualEldEnabled?: boolean | null } | null | undefined,
): boolean {
  return allowed && carrier?.virtualEldEnabled === true;
}

/**
 * D-142 — the ONE gate for virtual devices. Called from `IngestService.resolveContext` (all
 * `/ingest/*` + `GET /mobile/device-config`), `MobileDeviceService.reportMac` and
 * `POST /mobile/virtual-devices`. A real PT30/PT40 returns before any DB read, so the real
 * device path is unchanged.
 */
@Injectable()
export class VirtualEldPolicy {
  constructor(
    private readonly config: AppConfigService,
    private readonly carriers: CarrierRepository,
  ) {}

  /** §9.2 — env `VIRTUAL_ELD_ALLOWED` (default: not production). */
  get allowed(): boolean {
    return this.config.virtualEldAllowed;
  }

  async isEnabled(): Promise<boolean> {
    if (!this.allowed) return false;
    return resolveVirtualEldEnabled(true, await this.carriers.get());
  }

  /** 403 `VIRTUAL_ELD_DISABLED` unless the switch is on. */
  async assertEnabled(details?: Record<string, unknown>): Promise<void> {
    if (await this.isEnabled()) return;
    throw new AppException(
      ERROR_CODES.VIRTUAL_ELD_DISABLED,
      this.allowed
        ? 'Test PT30/40 (Virtual ELD) mode is turned off for this carrier.'
        : 'Virtual ELD is not allowed in this environment.',
      403,
      details,
    );
  }

  /** No-op for a real device; 403 `VIRTUAL_ELD_DISABLED` for a virtual one while the switch is off. */
  async assertDeviceUsable(device: { isVirtual?: boolean | null; serial: string }): Promise<void> {
    if (!isVirtualDevice(device)) return;
    await this.assertEnabled({ deviceSerial: device.serial });
  }
}
