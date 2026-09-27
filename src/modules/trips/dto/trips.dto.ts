import { z } from 'zod';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

export const TripStatusEnum = z.enum(['DRAFT', 'PLANNED', 'ASSIGNED', 'IN_PROGRESS', 'DELIVERED', 'CANCELLED']);
export const StopTypeEnum = z.enum(['PICKUP', 'DELIVERY', 'FUEL', 'REST', 'CHECKPOINT']);
export const StopStatusEnum = z.enum(['PENDING', 'ARRIVED', 'COMPLETED', 'SKIPPED']);

const StopDto = z.object({
  sequence: z.number().int().min(1),
  type: StopTypeEnum,
  name: z.string().min(1).max(200),
  address: z.string().max(300).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  scheduledAt: z.coerce.date().optional(),
  note: z.string().max(500).optional(),
});

/** TZ §11.5 `POST /trips` — "Dispatch & Trips" Figma sidebar entry.
 * §20 B-73 — `draft: true` creates the trip as `DRAFT` (never auto-ASSIGNED, even with a
 * `driverId`); publish it via `PATCH { status: 'PLANNED' }` once it is complete. */
export const CreateTripDto = z.object({
  number: z.string().min(1).max(40),
  driverId: z.string().uuid().optional(),
  vehicleId: z.string().uuid().optional(),
  trailerId: z.string().uuid().optional(),
  shippingDocument: z.string().max(60).optional(),
  commodity: z.string().max(120).optional(),
  weightLbs: z.number().int().min(0).optional(),
  pieces: z.number().int().min(0).optional(),
  plannedStartAt: z.coerce.date().optional(),
  plannedEndAt: z.coerce.date().optional(),
  notes: z.string().max(500).optional(),
  stops: z.array(StopDto).max(50).optional(),
  /** §20 B-73. */
  distanceMi: z.number().positive().max(10_000).optional(),
  /** §20 B-73. */
  rateUsd: z.number().positive().max(1_000_000).multipleOf(0.01).optional(),
  /** §20 B-73. */
  customer: z.string().max(200).optional(),
  /** §20 B-92, seconds. */
  estimatedDriveSec: z.number().int().positive().optional(),
  /** §20 B-73 — creates the trip as `DRAFT` instead of `PLANNED`/`ASSIGNED`. */
  draft: z.boolean().default(false),
});
export type CreateTripDto = z.infer<typeof CreateTripDto>;

export const UpdateTripDto = z.object({
  status: TripStatusEnum.optional(),
  shippingDocument: z.string().max(60).optional(),
  commodity: z.string().max(120).optional(),
  weightLbs: z.number().int().min(0).optional(),
  pieces: z.number().int().min(0).optional(),
  plannedStartAt: z.coerce.date().optional(),
  plannedEndAt: z.coerce.date().optional(),
  etaAt: z.coerce.date().optional(),
  notes: z.string().max(500).optional(),
  distanceMi: z.number().positive().max(10_000).optional(),
  rateUsd: z.number().positive().max(1_000_000).multipleOf(0.01).optional(),
  customer: z.string().max(200).optional(),
  estimatedDriveSec: z.number().int().positive().optional(),
});
export type UpdateTripDto = z.infer<typeof UpdateTripDto>;

export const AssignTripDto = z.object({
  driverId: z.string().uuid(),
  vehicleId: z.string().uuid().optional(),
  trailerId: z.string().uuid().optional(),
  /** §20 B-74 — sends the existing driver-app assignment notification unless explicitly off. */
  notify: z.boolean().default(true),
});
export type AssignTripDto = z.infer<typeof AssignTripDto>;

export const TripListQueryDto = ListQueryDto.extend({
  status: TripStatusEnum.optional(),
  driverId: z.string().uuid().optional(),
});
export type TripListQueryDto = z.infer<typeof TripListQueryDto>;
