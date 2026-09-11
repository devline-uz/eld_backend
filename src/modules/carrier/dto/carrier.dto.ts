import { z } from 'zod';

export const HosRulesetEnum = z.enum(['US_70_8_PROPERTY', 'US_60_7_PROPERTY', 'US_70_8_PASSENGER', 'US_60_7_PASSENGER']);
export const DistanceUnitEnum = z.enum(['MILES', 'KILOMETERS']);
export const ErodsModeEnum = z.enum(['TEST', 'PRODUCTION']);

/**
 * §395 Appendix A (ELD Identifier / ELD Registration ID) — **exactly 4 characters, and only
 * `A-Z` / `0-9`**. Length alone is not enough: a 4-character value containing a lowercase
 * letter, a space, a comma or `#` still invalidates the output CSV (the header segment is
 * comma-delimited and the file name in 4.8.2.2 is uppercase alphanumeric only).
 *
 * Input is trimmed and upper-cased before the check, so `'obk1'` is stored as `'OBK1'`;
 * anything else outside the alphabet is rejected with `422 VALIDATION_FAILED`.
 * Mirrored at the DB level by the `eld_identifier_format` / `eld_registration_id_format`
 * CHECK constraints (migration `20260911150000_erods_identifier_charset`).
 */
export const ErodsIdentifierSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4}$/, 'Must be exactly 4 characters, A-Z or 0-9 only (§395 Appendix A).');

/**
 * TZ §5.1 / §11.7 `PATCH /carrier` — company profile fields. All optional (partial update).
 */
export const UpdateCarrierDto = z.object({
  name: z.string().min(1).max(200).optional(),
  dotNumber: z.string().min(1).max(20).optional(),
  mcNumber: z.string().max(20).optional(),
  ein: z.string().max(20).optional(),
  timezone: z.string().min(1).max(60).optional(),
  hosRuleset: HosRulesetEnum.optional(),
  distanceUnit: DistanceUnitEnum.optional(),
  cycleRestart: z.boolean().optional(),
  unassignedThresholdMin: z.number().int().min(0).max(60).optional(),
  dvirRetentionMonths: z.number().int().min(1).max(120).optional(),
  allowPersonalConveyance: z.boolean().optional(),
  allowYardMove: z.boolean().optional(),
  addressLine1: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(50).optional(),
  zip: z.string().max(20).optional(),
  phone: z.string().max(30).optional(),
  complianceEmail: z.string().email().max(200).optional(),
  logoUrl: z.string().max(500).optional(),
  eldIdentifier: ErodsIdentifierSchema.optional(),
  eldRegistrationId: ErodsIdentifierSchema.optional(),
  erodsMode: ErodsModeEnum.optional(),
});
export type UpdateCarrierDto = z.infer<typeof UpdateCarrierDto>;
