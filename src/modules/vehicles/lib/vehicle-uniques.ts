/**
 * The one normalisation `POST /vehicles` and `PATCH /vehicles/:id` share for the vehicle's
 * case/whitespace-insensitive unique values — ELD serial, license plate, plate (issuing) state.
 * Mirrors the web's `normalizeVehicleUniques` (eld_web `vehicleConflicts.ts`) and the partial
 * unique index `Vehicle_plate_state_live_key` (migration 20261007090000_vehicle_plate_state_live_unique).
 *
 * - `undefined` stays `undefined` (field not sent — a PATCH leaves it alone);
 * - `null` / `''` / whitespace-only become `null` (no value — never conflicts);
 * - anything else is trimmed and upper-cased.
 */
export function normalizeUniqueValue(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = value.trim().toUpperCase();
  return normalized === '' ? null : normalized;
}

/**
 * License plates are compared without spaces or dashes (CODE-044): "ABC 123", "abc-123" and
 * "ABC123" are one plate. Same `undefined` / `null` rules as `normalizeUniqueValue`. Mirrors the
 * web `normalizePlate` and migration 20261014200000_vehicle_unit_plate_canonical.
 */
export function normalizePlate(value: string | null | undefined): string | null | undefined {
  const normalized = normalizeUniqueValue(value);
  if (normalized == null) return normalized;
  const compact = normalized.replace(/[\s-]+/g, '');
  return compact === '' ? null : compact;
}

/** The unit number the app treats as "the same unit": trimmed, upper-cased, leading `#` dropped. */
export function canonicalUnitNumber(value: string): string {
  return value.trim().replace(/^#+/, '').toUpperCase();
}

export interface VehicleUniqueInput {
  licensePlate?: string | null;
  plateState?: string | null;
  /** The web sends the ELD serial as `deviceId`; `eldSerial` is accepted as an alias. */
  deviceId?: string | null;
  eldSerial?: string | null;
}

export interface NormalizedVehicleUniques {
  licensePlate: string | null | undefined;
  plateState: string | null | undefined;
  /** Normalised ELD serial (`deviceId` wins over `eldSerial`); `null` = unpair, `undefined` = untouched. */
  eldSerial: string | null | undefined;
}

export function normalizeVehicleUniques(dto: VehicleUniqueInput): NormalizedVehicleUniques {
  return {
    licensePlate: normalizePlate(dto.licensePlate),
    plateState: normalizeUniqueValue(dto.plateState),
    eldSerial: normalizeUniqueValue(dto.deviceId !== undefined ? dto.deviceId : dto.eldSerial),
  };
}

export const UNIT_NUMBER_TAKEN_MESSAGE = 'A unit with this number already exists.';
export const VIN_TAKEN_MESSAGE = 'A unit with this VIN already exists.';
export const ELD_SERIAL_TAKEN_MESSAGE = 'This ELD serial is already assigned to another unit.';
export const LICENSE_PLATE_TAKEN_MESSAGE = 'This license plate is already registered for this state.';
export const ELD_SERIAL_UNKNOWN_MESSAGE = 'No ELD device with this serial is registered.';
