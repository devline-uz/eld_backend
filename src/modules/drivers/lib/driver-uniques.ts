/**
 * B-100 — the one normalisation `POST /drivers`, `PATCH /drivers/:id` and `POST /drivers/import`
 * share for a driver's unique values. The keys match the web (`eld_web` MSW `fleetWrites.ts`
 * `phoneKey` / `cdlKey`) and the partial unique indexes `Driver_phone_live_key` /
 * `Driver_cdlNumber_live_key` (migration 20261007100000_driver_phone_cdl_live_unique).
 */

/** Stored value: trimmed; `''` -> `null`; `undefined` stays `undefined` (not sent). */
export function trimOrNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Emails are stored trimmed + lower-cased, so the exact `Driver_email_live_key` index is
 * case-insensitive in practice. */
export function normalizeEmail(value: string | null | undefined): string | null | undefined {
  const trimmed = trimOrNull(value);
  return typeof trimmed === 'string' ? trimmed.toLowerCase() : trimmed;
}

/** Phone comparison key: digits only, a leading US `1` on an 11-digit number dropped
 * (`+1 (614) 555-1000` = `6145551000`). `null` when there are no digits (never conflicts). */
export function phoneKey(value: string | null | undefined): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  const key = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return key === '' ? null : key;
}

/** Licence-number comparison key: upper-cased, whitespace and dashes removed. */
export function cdlKey(value: string | null | undefined): string | null {
  const key = String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  return key === '' ? null : key;
}

/** Field-level 409 copy — exactly the web's `VALIDATION_MESSAGES` (eld_web `shared/forms/messages.ts`). */
export const DRIVER_CONFLICT_MESSAGES = {
  username: 'A driver with this username already exists.',
  email: 'A driver with this email address already exists.',
  phone: 'A driver with this phone number already exists.',
  cdlNumber: 'A driver with this licence number already exists.',
  assignedVehicleId: 'This unit already has a driver assigned.',
} as const;

export type DriverConflictField = keyof typeof DRIVER_CONFLICT_MESSAGES;
