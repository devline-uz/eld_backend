import { z } from 'zod';

export const DriverStatusEnum = z.enum(['ACTIVE', 'INACTIVE', 'TERMINATED']);
export const HosRulesetEnum = z.enum([
  'US_70_8_PROPERTY',
  'US_60_7_PROPERTY',
  'US_70_8_PASSENGER',
  'US_60_7_PASSENGER',
]);

/** TZ §5.3 — driver identity, CDL, and the per-driver exception flags. */
export const CreateDriverDto = z.object({
  username: z.string().min(3).max(40),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional(),
  cdlNumber: z.string().min(1).max(40),
  cdlState: z.string().min(2).max(10),

  // RODS day boundary follows this timezone, never Carrier.timezone (TZ §5.3).
  homeTerminalName: z.string().min(1).max(120),
  homeTerminalTimezone: z.string().min(1).max(64).default('America/New_York'),

  hosRuleset: HosRulesetEnum.default('US_70_8_PROPERTY'),
  fleetManagerId: z.string().uuid().optional(),

  allowPersonalConveyance: z.boolean().default(false),
  allowYardMove: z.boolean().default(false),
  adverseDrivingEnabled: z.boolean().default(false),
  shortHaulException: z.boolean().default(false),
  splitSleeperEnabled: z.boolean().default(false),
  eldExempt: z.boolean().default(false),
  eldExemptReason: z.string().max(200).optional(),

  /** Optional; a random temp password is generated (and hashed, never returned) if omitted. */
  password: z.string().min(8).max(72).optional(),

  /** §20 B-82 — defaults true (current behavior: always invite). */
  sendInvitation: z.boolean().default(true),

  /** B-100 — unit to assign on create. A unit another live driver already has is a 409
   * `VEHICLE_ALREADY_ASSIGNED` (never silently taken); an out-of-service unit is a 409
   * `VEHICLE_OUT_OF_SERVICE`. Not accepted on update — reassigning is
   * `POST /vehicles/:id/assign-driver` (11.5). */
  assignedVehicleId: z.string().uuid().nullable().optional(),
});
export type CreateDriverDto = z.infer<typeof CreateDriverDto>;

export const UpdateDriverDto = CreateDriverDto.omit({ username: true, password: true, assignedVehicleId: true })
  .partial()
  .extend({ status: DriverStatusEnum.optional() });
export type UpdateDriverDto = z.infer<typeof UpdateDriverDto>;

export const DriverListQueryDto = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(60).optional(),
  q: z.string().max(200).optional(),
  status: DriverStatusEnum.optional(),
});
export type DriverListQueryDto = z.infer<typeof DriverListQueryDto>;

const QueryBool = z.enum(['true', 'false']).transform((value) => value === 'true');

/** `GET /drivers/roster` (web gap B-1) — the list params plus the W-06 11.23 filter groups (gap B-55). */
export const DriverRosterQueryDto = DriverListQueryDto.extend({
  terminal: z.string().max(120).optional(),
  hasOpenViolation: QueryBool.optional(),
  exempt: QueryBool.optional(),
});
export type DriverRosterQueryDto = z.infer<typeof DriverRosterQueryDto>;

/** §20 B-69 — options that actually change import behavior, not just carried along. */
export const ImportDriversOptionsDto = z.object({
  duplicateStrategy: z.enum(['SKIP', 'UPDATE', 'CREATE']).default('UPDATE'),
  defaultHomeTerminalName: z.string().min(1).max(120).optional(),
  sendInvitations: z.boolean().default(false),
  applyDefaultExemptions: z.boolean().default(false),
});
export type ImportDriversOptionsDto = z.infer<typeof ImportDriversOptionsDto>;

export const ImportDriversDto = z.object({
  drivers: z.array(CreateDriverDto).min(1).max(1000),
  options: ImportDriversOptionsDto.optional(),
});
export type ImportDriversDto = z.infer<typeof ImportDriversDto>;

/** §20 B-94 (tz.md §20 B-16) — driver qualification documents (CDL scan, medical card, ...). */
export const DriverDocumentTypeEnum = z.enum(['CDL', 'MEDICAL_CARD', 'MVR', 'OTHER']);

/** B-091 — the only MIME types a driver qualification document may be uploaded as. Anything
 * a browser would render as active content (`text/html`, `image/svg+xml`, ...) is refused. */
export const DRIVER_DOCUMENT_CONTENT_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/webp': 'webp',
} as const;
export const DRIVER_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

export const CreateDriverDocumentDto = z.object({
  type: DriverDocumentTypeEnum,
  /** Display name only — never part of the storage key (B-091). */
  fileName: z.string().min(1).max(200),
  contentType: z.enum(Object.keys(DRIVER_DOCUMENT_CONTENT_TYPES) as [keyof typeof DRIVER_DOCUMENT_CONTENT_TYPES, ...(keyof typeof DRIVER_DOCUMENT_CONTENT_TYPES)[]]),
  /** Exact byte size of the file; signed into the presigned PUT as `content-length`. */
  sizeBytes: z.number().int().min(1).max(DRIVER_DOCUMENT_MAX_BYTES),
  expiresAt: z.coerce.date().optional(),
});
export type CreateDriverDocumentDto = z.infer<typeof CreateDriverDocumentDto>;

export const VerifyDriverEmailDto = z.object({
  token: z.string().min(1),
});
export type VerifyDriverEmailDto = z.infer<typeof VerifyDriverEmailDto>;
