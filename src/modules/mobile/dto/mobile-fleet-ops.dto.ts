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

/** §12 notes field on the app screen is capped at 60 chars — narrower than `Trip.notes`
 * (VarChar(500)) because the mobile "trip notes" box on P-03 is a single short line. */
export const TripPatchDto = z
  .object({
    shippingDocument: z.string().trim().min(1).max(200).optional(),
    trailerNumber: z.string().trim().min(1).max(50).optional(),
    notes: z.string().trim().max(60).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required.' });
export type TripPatchDto = z.infer<typeof TripPatchDto>;

// ---------------------------------------------------------------------------
// MB-10 — own DVIR history (M-10/M-11/P-07)
// ---------------------------------------------------------------------------

export const DvirHistoryQueryDto = z.object({
  days: z.coerce.number().int().min(1).max(90).default(14),
});
export type DvirHistoryQueryDto = z.infer<typeof DvirHistoryQueryDto>;
