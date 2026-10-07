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
    licensePlate: normalizeUniqueValue(dto.licensePlate),
    plateState: normalizeUniqueValue(dto.plateState),
    eldSerial: normalizeUniqueValue(dto.deviceId !== undefined ? dto.deviceId : dto.eldSerial),
  };
}

export const UNIT_NUMBER_TAKEN_MESSAGE = 'A unit with this number already exists.';
export const VIN_TAKEN_MESSAGE = 'A unit with this VIN already exists.';
export const ELD_SERIAL_TAKEN_MESSAGE = 'This ELD serial is already assigned to another unit.';
export const LICENSE_PLATE_TAKEN_MESSAGE = 'This license plate is already registered for this state.';
export const ELD_SERIAL_UNKNOWN_MESSAGE = 'No ELD device with this serial is registered.';
