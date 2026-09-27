import { z } from 'zod';

const QueryBool = z.enum(['true', 'false']).transform((value) => value === 'true');

/** §20 B-7 — team-driving pairing is a TIME-BOUNDED row, never a plain column on `Driver`
 * (hard rule). `GET /co-driver-pairings?vehicleId=&active=`. */
export const CoDriverPairingListQueryDto = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  vehicleId: z.string().uuid().optional(),
  driverId: z.string().uuid().optional(),
  /** `true` = `endedAt IS NULL`, `false` = ended pairings only. Omitted = all. */
  active: QueryBool.optional(),
});
export type CoDriverPairingListQueryDto = z.infer<typeof CoDriverPairingListQueryDto>;

export const CreateCoDriverPairingDto = z.object({
  primaryDriverId: z.string().uuid(),
  coDriverId: z.string().uuid(),
  vehicleId: z.string().uuid(),
  startedAt: z.coerce.date().optional(),
});
export type CreateCoDriverPairingDto = z.infer<typeof CreateCoDriverPairingDto>;
