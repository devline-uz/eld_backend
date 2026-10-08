import { z } from 'zod';

export const HosRulesetEnum = z.enum(['US_70_8_PROPERTY', 'US_60_7_PROPERTY', 'US_70_8_PASSENGER', 'US_60_7_PASSENGER']);
export const DistanceUnitEnum = z.enum(['MILES', 'KILOMETERS']);
export const ErodsModeEnum = z.enum(['TEST', 'PRODUCTION']);

/**
 * §395 Appendix A 7.15 — ELD Identifier: **exactly 6 characters, `A-Z` / `0-9` only**
 * (provider-coded at certification, e.g. `1001ZE`; `OBK001` in TEST). bugs.md B-138.
 * §395 Appendix A 7.17 — ELD Registration ID: **exactly 4 characters, `A-Z` / `0-9` only**
 * (FMCSA-issued, e.g. `ZA10`).
 *
 * Length alone is not enough: a value containing a lowercase letter, a space, a comma or `#`
 * still invalidates the output CSV (the header segment is comma-delimited). Input is trimmed
 * and upper-cased before the check (`'obk001'` is stored as `'OBK001'`); anything else is
 * rejected with `422 VALIDATION_FAILED`. Mirrored at the DB level by the
 * `eld_identifier_format` (`^[A-Z0-9]{6}$`, migration `20261008130000_eld_identifier_six_chars`)
 * and `eld_registration_id_format` (`^[A-Z0-9]{4}$`) CHECK constraints.
 */
export const EldIdentifierSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/, 'ELD Identifier must be exactly 6 characters, A-Z or 0-9 only (§395 Appendix A 7.15).');

export const EldRegistrationIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4}$/, 'ELD Registration ID must be exactly 4 characters, A-Z or 0-9 only (§395 Appendix A 7.17).');

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
  eldIdentifier: EldIdentifierSchema.optional(),
  eldRegistrationId: EldRegistrationIdSchema.optional(),
  erodsMode: ErodsModeEnum.optional(),
});
export type UpdateCarrierDto = z.infer<typeof UpdateCarrierDto>;
