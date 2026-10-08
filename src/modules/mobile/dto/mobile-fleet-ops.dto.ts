import { z } from 'zod';

/**
 * Phase 6b (tasks.md "Mobile API gaps") — MB-2/MB-3/MB-5/MB-10/MB-14.
 *
 * A separate file from `dto/mobile.dto.ts` on purpose (see `mobile/decisions.md` MD-001 and
 * the Phase 6b shared-file list): several agents touch that file concurrently for other
 * gaps, and none of these DTOs are needed there.
 */

// ---------------------------------------------------------------------------
// MB-2 — vehicle selection (M-03)
// ---------------------------------------------------------------------------

export const SelectVehicleDto = z.object({
  vehicleId: z.string().uuid(),
});
export type SelectVehicleDto = z.infer<typeof SelectVehicleDto>;

/** MR-32 — `GET /mobile/available-vehicles?q=&limit=`. `limit` is optional; absent = no cap. */
export const AvailableVehiclesQueryDto = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type AvailableVehiclesQueryDto = z.infer<typeof AvailableVehiclesQueryDto>;

/** MR-2 — `POST /mobile/release-vehicle`. `clientId` makes an offline replay return the first answer. */
export const ReleaseVehicleDto = z.object({
  clientId: z.string().uuid().nullish(),
  reason: z.string().trim().max(200).nullish(),
});
export type ReleaseVehicleDto = z.infer<typeof ReleaseVehicleDto>;

// ---------------------------------------------------------------------------
// MB-3 — co-driver switch / leave (S-11/S-18/S-19)
// ---------------------------------------------------------------------------

export const CoDriverSwitchDto = z.object({
  coDriverPassword: z.string().min(1).max(200),
});
export type CoDriverSwitchDto = z.infer<typeof CoDriverSwitchDto>;

// ---------------------------------------------------------------------------
// MB-5 — active trip (M-05/S-05/P-03)
// ---------------------------------------------------------------------------

/** The `trailerNumber` value (case-insensitive) that means "no trailer" (MR-4). */
export const BOBTAIL = 'BOBTAIL';

/** `null` or `""` clear the field (MR-4); any other string is trimmed. */
const clearableString = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === null || value === '' ? null : value));

const stringList = (max: number) => z.array(z.string().trim().min(1).max(max)).max(20);

/** §12 notes field on the app screen is capped at 60 chars — narrower than `Trip.notes`
 * (VarChar(500)) because the mobile "trip notes" box on P-03 is a single short line.
 * MR-4: `null`/`""` clear `shippingDocument`/`trailerNumber`/`notes`; `trailerNumber:"BOBTAIL"`
 * or `bobtail:true` = no trailer; `shippingDocuments`/`trailerNumbers` are the multi-value forms
 * (an array wins over the single field when both are sent; `[]` clears). */
export const TripPatchDto = z
  .object({
    shippingDocument: clearableString(200).optional(),
    trailerNumber: clearableString(50).optional(),
    notes: clearableString(60).optional(),
    bobtail: z.boolean().optional(),
    shippingDocuments: stringList(200).optional(),
    trailerNumbers: stringList(50).optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), { message: 'At least one field is required.' });
export type TripPatchDto = z.infer<typeof TripPatchDto>;

// ---------------------------------------------------------------------------
// MB-10 — own DVIR history (M-10/M-11/P-07)
// ---------------------------------------------------------------------------

export const DvirHistoryQueryDto = z.object({
  days: z.coerce.number().int().min(1).max(90).default(14),
});
export type DvirHistoryQueryDto = z.infer<typeof DvirHistoryQueryDto>;

/** MR-8 — `GET /mobile/trailers?q=&limit=`. */
export const TrailerSearchQueryDto = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type TrailerSearchQueryDto = z.infer<typeof TrailerSearchQueryDto>;
