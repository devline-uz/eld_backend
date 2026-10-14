import { z } from 'zod';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

export const TripStatusEnum = z.enum(['DRAFT', 'PLANNED', 'ASSIGNED', 'IN_PROGRESS', 'DELIVERED', 'CANCELLED']);
export const StopTypeEnum = z.enum(['PICKUP', 'DELIVERY', 'FUEL', 'REST', 'CHECKPOINT']);
export const StopStatusEnum = z.enum(['PENDING', 'ARRIVED', 'COMPLETED', 'SKIPPED']);

/** BE-008 — `Trip.weightLbs` / `pieces` / `estimatedDriveSec` are INT4: cap them at realistic
 * values (well under 2,147,483,647) so an oversized number is a 422, not a Postgres overflow 500. */
export const TRIP_LIMITS = {
  weightLbs: 1_000_000,
  pieces: 1_000_000,
  /** ~115 days — far beyond any 10,000 mi trip. */
  estimatedDriveSec: 10_000_000,
  stopSequence: 1_000,
} as const;

const StopDto = z.object({
  sequence: z.number().int().min(1).max(TRIP_LIMITS.stopSequence),
  type: StopTypeEnum,
  name: z.string().trim().min(1).max(200),
  address: z.string().max(300).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  scheduledAt: z.coerce.date().optional(),
  note: z.string().max(500).optional(),
});
type StopDto = z.infer<typeof StopDto>;

/**
 * BE-018 — stops form one route: `sequence` is unique (the DB's `@@unique([tripId, sequence])`
 * would otherwise surface as a 500), no DELIVERY comes before the first PICKUP, and the
 * `scheduledAt` times that are set never go backwards in sequence order (a stop without a time
 * — e.g. an intermediate stop the dispatcher left blank — is skipped, coordinates stay optional).
 */
const StopsDto = z
  .array(StopDto)
  .max(50)
  .superRefine((stops: StopDto[], ctx) => {
    const seen = new Map<number, number>();
    stops.forEach((stop, index) => {
      if (seen.has(stop.sequence)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'sequence'], message: 'Stop sequence numbers must be unique.' });
      }
      seen.set(stop.sequence, index);
    });
    const ordered = stops.map((stop, index) => ({ stop, index })).sort((a, b) => a.stop.sequence - b.stop.sequence);
    const firstPickup = ordered.find((o) => o.stop.type === 'PICKUP');
    if (firstPickup) {
      const early = ordered.find((o) => o.stop.type === 'DELIVERY' && o.stop.sequence < firstPickup.stop.sequence);
      if (early) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [early.index, 'sequence'], message: 'A delivery cannot come before the pickup.' });
      }
    }
    let previous: Date | undefined;
    for (const { stop, index } of ordered) {
      if (!stop.scheduledAt) continue;
      if (previous && stop.scheduledAt.getTime() < previous.getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'scheduledAt'],
          message: 'Stop times must not go backwards along the route.',
        });
      }
      previous = stop.scheduledAt;
    }
  });

/** TZ §11.5 `POST /trips` — "Dispatch & Trips" Figma sidebar entry.
 * §20 B-73 — `draft: true` creates the trip as `DRAFT` (never auto-ASSIGNED, even with a
 * `driverId`); publish it via `PATCH { status: 'PLANNED' }` once it is complete — a draft with a
 * driver is then dispatched as `ASSIGNED` (CODE-005). */
export const CreateTripDto = z.object({
  /** BE-015 — trimmed; whitespace-only is rejected. */
  number: z.string().trim().min(1).max(40),
  driverId: z.string().uuid().optional(),
  vehicleId: z.string().uuid().optional(),
  trailerId: z.string().uuid().optional(),
  shippingDocument: z.string().max(60).optional(),
  commodity: z.string().max(120).optional(),
  weightLbs: z.number().int().min(0).max(TRIP_LIMITS.weightLbs).optional(),
  pieces: z.number().int().min(0).max(TRIP_LIMITS.pieces).optional(),
  plannedStartAt: z.coerce.date().optional(),
  plannedEndAt: z.coerce.date().optional(),
  notes: z.string().max(500).optional(),
  stops: StopsDto.optional(),
  /** §20 B-73. */
  distanceMi: z.number().positive().max(10_000).optional(),
  /** §20 B-73. */
  rateUsd: z.number().positive().max(1_000_000).multipleOf(0.01).optional(),
  /** §20 B-73. */
  customer: z.string().max(200).optional(),
  /** §20 B-92, seconds. */
  estimatedDriveSec: z.number().int().positive().max(TRIP_LIMITS.estimatedDriveSec).optional(),
  /** §20 B-73 — creates the trip as `DRAFT` instead of `PLANNED`/`ASSIGNED`. */
  draft: z.boolean().default(false),
});
export type CreateTripDto = z.infer<typeof CreateTripDto>;

export const UpdateTripDto = z.object({
  status: TripStatusEnum.optional(),
  shippingDocument: z.string().max(60).optional(),
  commodity: z.string().max(120).optional(),
  weightLbs: z.number().int().min(0).max(TRIP_LIMITS.weightLbs).optional(),
  pieces: z.number().int().min(0).max(TRIP_LIMITS.pieces).optional(),
  plannedStartAt: z.coerce.date().optional(),
  plannedEndAt: z.coerce.date().optional(),
  etaAt: z.coerce.date().optional(),
  notes: z.string().max(500).optional(),
  distanceMi: z.number().positive().max(10_000).optional(),
  rateUsd: z.number().positive().max(1_000_000).multipleOf(0.01).optional(),
  customer: z.string().max(200).optional(),
  estimatedDriveSec: z.number().int().positive().max(TRIP_LIMITS.estimatedDriveSec).optional(),
  /** LIVE-003 — the actual delivery time the dispatcher records with "Mark delivered"; only valid
   * together with `status: 'DELIVERED'` (default: now). Never in the future, never before the start. */
  completedAt: z.coerce.date().optional(),
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
