import { z } from 'zod';

export const VehicleStatusEnum = z.enum(['ACTIVE', 'INACTIVE', 'OUT_OF_SERVICE']);
export const FuelTypeEnum = z.enum(['DIESEL', 'GASOLINE', 'CNG', 'LNG', 'ELECTRIC']);
export const BusTypeEnum = z.enum(['J1939', 'J1708', 'OBD_II']);

/** ISO 3779 VIN alphabet: 17 characters, digits and letters except I, O and Q. */
export const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;
export const VIN_MESSAGE = 'A VIN is 17 characters and cannot contain I, O or Q.';

/** Web-panel VIN (`POST /vehicles`, `PATCH /vehicles/:id`, `POST /vehicles/import`) — trimmed and
 * upper-cased first, then held to the ISO 3779 alphabet. This DTO file is used only by the
 * web-panel vehicles controller; mobile/tablet endpoints never parse it. */
export const VinField = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(VIN_PATTERN, VIN_MESSAGE));

/** TZ §5.3 — unit inventory fields ("Unit inventory — ELD serial, VIN, odometer" screen). */
export const CreateVehicleDto = z.object({
  unitNumber: z.string().min(1).max(40),
  vin: VinField,
  make: z.string().max(60).optional(),
  model: z.string().max(60).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  /** Unique together with `plateState` among live units (trim/case-insensitive); `null`/`''` = no plate. */
  licensePlate: z.string().max(20).nullable().optional(),
  plateState: z.string().max(10).nullable().optional(),
  fuelType: FuelTypeEnum.default('DIESEL'),
  sleeperBerth: z.boolean().default(false),
  // TZ §4.3 step 1 — the dash odometer the user reads off the panel when adding the unit.
  odometerMi: z.number().int().min(0).default(0),
  busType: BusTypeEnum.optional(),
  notes: z.string().max(500).optional(),
  /** Vehicle group (`/vehicle-groups`); `null` on update removes the unit from its group. */
  groupId: z.string().uuid().nullable().optional(),
  /** ELD device to pair, by its serial (what the web's "ELD serial" input sends as `deviceId`). A
   * device can be paired to at most one live unit; on update `null`/`''` unpairs the current one. */
  deviceId: z.string().max(60).nullable().optional(),
  /** Alias of `deviceId`; `deviceId` wins when both are sent. */
  eldSerial: z.string().max(60).nullable().optional(),
});
export type CreateVehicleDto = z.infer<typeof CreateVehicleDto>;

export const UpdateVehicleDto = CreateVehicleDto.partial().extend({
  status: VehicleStatusEnum.optional(),
});
export type UpdateVehicleDto = z.infer<typeof UpdateVehicleDto>;

/**
 * TZ §4.3 step 4 — `POST /vehicles/:id/calibrate-odometer`. `odometerMi` is the *true* dash
 * value the user just read off the panel; the offset against the last device reading is
 * recomputed from it (§4.3's `computeOdometerOffsetMi`).
 */
export const CalibrateOdometerDto = z.object({
  odometerMi: z.number().int().min(0),
});
export type CalibrateOdometerDto = z.infer<typeof CalibrateOdometerDto>;

export const AssignDriverDto = z.object({
  driverId: z.string().uuid(),
  effectiveAt: z.coerce.date().optional(),
  /** §20 B-74 — sends the existing driver-app notification on assignment; defaults to true. */
  notify: z.boolean().default(true),
});
export type AssignDriverDto = z.infer<typeof AssignDriverDto>;

/** §20 B-71 — `PATCH /vehicles/bulk-status`, one transaction per row with per-row errors. */
export const BulkUpdateVehicleStatusDto = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  status: VehicleStatusEnum,
});
export type BulkUpdateVehicleStatusDto = z.infer<typeof BulkUpdateVehicleStatusDto>;

/** §20 B-4 — `GET /vehicles/:id/histories?date=`. */
export const VehicleHistoriesQueryDto = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
});
export type VehicleHistoriesQueryDto = z.infer<typeof VehicleHistoriesQueryDto>;

/** §20 B-1 (telemetry read) — `GET /vehicles/:id/telemetry`. */
export const VehicleTelemetryQueryDto = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});
export type VehicleTelemetryQueryDto = z.infer<typeof VehicleTelemetryQueryDto>;

export const VehicleListQueryFields = ['unitNumber', 'vin', 'make', 'model', 'createdAt'] as const;

export const VehicleListQueryDto = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(60).optional(),
  q: z.string().max(200).optional(),
  status: VehicleStatusEnum.optional(),
  /** A group id, or `none` for units in no group. */
  groupId: z.union([z.string().uuid(), z.literal('none')]).optional(),
});
export type VehicleListQueryDto = z.infer<typeof VehicleListQueryDto>;

/** §20 B-69 — options that actually change import behavior, not just carried along. */
export const ImportVehiclesOptionsDto = z.object({
  duplicateStrategy: z.enum(['UPDATE_BY_VIN', 'SKIP', 'CREATE']).default('UPDATE_BY_VIN'),
  defaultTerminal: z.string().max(120).optional(),
  pairDevices: z.boolean().default(false),
  emailSummary: z.boolean().default(false),
});
export type ImportVehiclesOptionsDto = z.infer<typeof ImportVehiclesOptionsDto>;

/** A row can additionally carry a `deviceSerial` to pair — only consumed when
 * `options.pairDevices` is true (§20 B-69). Import rows pair through `deviceSerial` only, so the
 * `POST /vehicles` `deviceId` / `eldSerial` fields are not part of a row. */
export const ImportVehicleRowDto = CreateVehicleDto.omit({ deviceId: true, eldSerial: true }).extend({
  deviceSerial: z.string().max(60).optional(),
});
export type ImportVehicleRowDto = z.infer<typeof ImportVehicleRowDto>;

/** Fleet import (TZ Phase 2 — "fleet import"/"fleet export" round-trip without loss). */
export const ImportVehiclesDto = z.object({
  vehicles: z.array(ImportVehicleRowDto).min(1).max(1000),
  options: ImportVehiclesOptionsDto.optional(),
});
export type ImportVehiclesDto = z.infer<typeof ImportVehiclesDto>;

export const CreateTrailerDto = z.object({
  number: z.string().min(1).max(40),
  vin: z.string().max(17).optional(),
});
export type CreateTrailerDto = z.infer<typeof CreateTrailerDto>;

export const UpdateTrailerDto = CreateTrailerDto.partial().extend({
  status: VehicleStatusEnum.optional(),
});
export type UpdateTrailerDto = z.infer<typeof UpdateTrailerDto>;

export const ImportTrailersDto = z.object({
  trailers: z.array(CreateTrailerDto).min(1).max(1000),
});
export type ImportTrailersDto = z.infer<typeof ImportTrailersDto>;

/** `GET /trailers` — same `?page&limit&sort&q&status` contract and defaults as `GET /vehicles`.
 * `q` matches `number` / `vin` (case-insensitive substring); `sort` is `field:asc|desc` over
 * {@link TrailerListSortFields}, falling back to `number:asc`. Soft-deleted trailers never appear. */
export const TrailerListSortFields = ['number', 'vin', 'status'] as const;

export const TrailerListQueryDto = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(60).optional(),
  q: z.string().max(200).optional(),
  status: VehicleStatusEnum.optional(),
});
export type TrailerListQueryDto = z.infer<typeof TrailerListQueryDto>;

/** Vehicle groups — web W-12 IFTA `Vehicle group` filter, W-13 Activity `Group by`. */
export const CreateVehicleGroupDto = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).nullable().optional(),
  /** Display colour for the group chip, `#RRGGBB`. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be #RRGGBB')
    .nullable()
    .optional(),
  /** Units to put in the group on create (each moves out of any previous group). */
  vehicleIds: z.array(z.string().uuid()).max(1000).optional(),
});
export type CreateVehicleGroupDto = z.infer<typeof CreateVehicleGroupDto>;

export const UpdateVehicleGroupDto = CreateVehicleGroupDto.omit({ vehicleIds: true }).partial();
export type UpdateVehicleGroupDto = z.infer<typeof UpdateVehicleGroupDto>;

/** `PUT /vehicle-groups/:id/vehicles` — replaces the group's membership with exactly these units. */
export const SetVehicleGroupMembersDto = z.object({
  vehicleIds: z.array(z.string().uuid()).max(1000),
});
export type SetVehicleGroupMembersDto = z.infer<typeof SetVehicleGroupMembersDto>;
