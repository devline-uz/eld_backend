import { IANAZone } from 'luxon';
import { z } from 'zod';

export const INVALID_TIMEZONE_MESSAGE = 'Must be a valid IANA time zone, e.g. America/Chicago.';

/**
 * BE-003 — an IANA time-zone name (`America/Chicago`, `UTC`). The RODS day boundary and every
 * HOS calculation run in this zone, so a typo (`America/Chicagoo`, `CST6`) must be a 422 at the
 * edge, never stored and left to crash HOS later. Trimmed first.
 */
export const IanaTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => IANAZone.isValidZone(value), INVALID_TIMEZONE_MESSAGE);

/** BE-003 — `true` when HOS can run in `timezone`. Web readers use it to skip (and log) a driver
 * whose stored zone predates the DTO check, instead of letting one bad row fail the whole screen. */
export function isValidIanaTimezone(timezone: string | null | undefined): boolean {
  return typeof timezone === 'string' && IANAZone.isValidZone(timezone);
}
