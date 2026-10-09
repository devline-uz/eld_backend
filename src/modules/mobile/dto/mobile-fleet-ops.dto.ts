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

/**
 * D-129 — 49 CFR 395 Appendix A 7.42 "Trailer Number(s)": each number is trimmed and upper-cased,
 * 1-10 characters of `[A-Z0-9-]`. A space is NOT allowed inside one number because the output
 * file joins several trailers with a single space (7.42 data format). §395 wins over the
 * 1-32-char request rule here (see D-129).
 */
export const TRAILER_NUMBER_PATTERN = /^[A-Z0-9-]{1,10}$/;
/** Appendix A 7.42 — the whole space-separated Trailer Number(s) field is at most 32 characters. */
export const TRAILER_FIELD_MAX = 32;
/** Appendix A 7.39 — Shipping Document Number is 0-40 characters. */
export const SHIPPING_DOCUMENT_MAX = 40;
const TRAILER_FORMAT_MESSAGE = 'A trailer number is 1-10 characters A-Z, 0-9 or "-" (49 CFR 395 Appendix A 7.42).';

const isTrailerToken = (value: string) => value === BOBTAIL || TRAILER_NUMBER_PATTERN.test(value);

/** `null`/`""` clear; anything else is trimmed, upper-cased and must be a 7.42 trailer number or BOBTAIL. */
const clearableTrailer = z
  .string()
  .trim()
  .nullable()
  .transform((value) => (value === null || value === '' ? null : value.toUpperCase()))
  .refine((value) => value === null || isTrailerToken(value), { message: TRAILER_FORMAT_MESSAGE });

const trailerList = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .transform((value) => value.toUpperCase())
      .refine(isTrailerToken, { message: TRAILER_FORMAT_MESSAGE }),
  )
  .max(20);

/** §12 notes field on the app screen is capped at 60 chars — narrower than `Trip.notes`
 * (VarChar(500)) because the mobile "trip notes" box on P-03 is a single short line.
 * MR-4: `null`/`""` clear `shippingDocument`/`trailerNumber`/`notes`; `trailerNumber:"BOBTAIL"`
 * or `bobtail:true` = no trailer; `shippingDocuments`/`trailerNumbers` are the multi-value forms
 * (an array wins over the single field when both are sent; `[]` clears).
 * D-129: trailer numbers are free text in the Appendix A 7.42 format (no TRAILER_NOT_FOUND); the
 * joined list is at most 32 chars; shipping documents are at most 40 chars each (7.39). `logDate`
 * (home-terminal `YYYY-MM-DD`) only matters when there is no active trip — it names the RODS day
 * whose day details are written (default: today), so an offline replay lands on the right day. */
export const TripPatchDto = z
  .object({
    shippingDocument: clearableString(SHIPPING_DOCUMENT_MAX).optional(),
    trailerNumber: clearableTrailer.optional(),
    notes: clearableString(60).optional(),
    bobtail: z.boolean().optional(),
    shippingDocuments: stringList(SHIPPING_DOCUMENT_MAX).optional(),
    trailerNumbers: trailerList.optional(),
    logDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'logDate must be YYYY-MM-DD.')
      .optional(),
  })
  .refine(
    (value) => Object.entries(value).some(([key, v]) => key !== 'logDate' && v !== undefined),
    { message: 'At least one field is required.' },
  )
  .superRefine((value, ctx) => {
    const requested = value.trailerNumbers ?? (value.trailerNumber ? [value.trailerNumber] : []);
    const joined = requested.filter((n) => n !== BOBTAIL).join(' ');
    if (joined.length > TRAILER_FIELD_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [value.trailerNumbers ? 'trailerNumbers' : 'trailerNumber'],
        message: `Trailer numbers joined by spaces must be at most ${TRAILER_FIELD_MAX} characters (49 CFR 395 Appendix A 7.42).`,
      });
    }
  });
export type TripPatchDto = z.infer<typeof TripPatchDto>;

/** D-129 — `GET /mobile/trip?date=`: the RODS day whose day details are returned when there is no active trip. */
export const TripQueryDto = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD.')
    .optional(),
});
export type TripQueryDto = z.infer<typeof TripQueryDto>;

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
