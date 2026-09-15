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
});
export type CreateDriverDto = z.infer<typeof CreateDriverDto>;

export const UpdateDriverDto = CreateDriverDto.omit({ username: true, password: true })
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

export const ImportDriversDto = z.object({
  drivers: z.array(CreateDriverDto).min(1).max(1000),
});
export type ImportDriversDto = z.infer<typeof ImportDriversDto>;
