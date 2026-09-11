import { z } from 'zod';

export const VehicleStatusEnum = z.enum(['ACTIVE', 'INACTIVE', 'OUT_OF_SERVICE']);
export const FuelTypeEnum = z.enum(['DIESEL', 'GASOLINE', 'CNG', 'LNG', 'ELECTRIC']);
export const BusTypeEnum = z.enum(['J1939', 'J1708', 'OBD_II']);

/** TZ §5.3 — unit inventory fields ("Unit inventory — ELD serial, VIN, odometer" screen). */
export const CreateVehicleDto = z.object({
  unitNumber: z.string().min(1).max(40),
  vin: z.string().min(1).max(17),
  make: z.string().max(60).optional(),
  model: z.string().max(60).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  licensePlate: z.string().max(20).optional(),
  plateState: z.string().max(10).optional(),
  fuelType: FuelTypeEnum.default('DIESEL'),
  sleeperBerth: z.boolean().default(false),
  // TZ §4.3 step 1 — the dash odometer the user reads off the panel when adding the unit.
  odometerMi: z.number().int().min(0).default(0),
  busType: BusTypeEnum.optional(),
  notes: z.string().max(500).optional(),
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
});
export type AssignDriverDto = z.infer<typeof AssignDriverDto>;

export const VehicleListQueryFields = ['unitNumber', 'vin', 'make', 'model', 'createdAt'] as const;

export const VehicleListQueryDto = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(60).optional(),
  q: z.string().max(200).optional(),
  status: VehicleStatusEnum.optional(),
});
export type VehicleListQueryDto = z.infer<typeof VehicleListQueryDto>;

/** Fleet import (TZ Phase 2 — "fleet import"/"fleet export" round-trip without loss). */
export const ImportVehiclesDto = z.object({
  vehicles: z.array(CreateVehicleDto).min(1).max(1000),
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
