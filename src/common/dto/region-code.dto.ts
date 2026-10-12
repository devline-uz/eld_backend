import { z } from 'zod';

/** USPS codes: 50 states, DC and the inhabited territories. */
const US_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
  'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR',
  'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR', 'GU', 'VI', 'AS', 'MP',
];
/** Canada Post province / territory codes (cross-border carriers plate and license there). */
const CA_CODES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];

export const REGION_CODES: ReadonlySet<string> = new Set([...US_CODES, ...CA_CODES]);
export const REGION_CODE_MESSAGE = 'Use the 2-letter US state or Canadian province code.';

/**
 * BE-017 — a CDL issuing state / plate state: trimmed, upper-cased (`' oh '` -> `'OH'`) and one of
 * {@link REGION_CODES}, so `'ZZZZZ'` is a 422 instead of being stored.
 */
export const RegionCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((value) => REGION_CODES.has(value), REGION_CODE_MESSAGE);

/** Same, but `''` stays allowed — an optional field the web clears with an empty input. */
export const OptionalRegionCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((value) => value === '' || REGION_CODES.has(value), REGION_CODE_MESSAGE);
