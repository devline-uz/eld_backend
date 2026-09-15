import { z } from 'zod';

/**
 * B-6 (web/tz.md §20) — `GET /violations`. W-01 sends `window=24h`; the rest are the fleet-list
 * filters the §11.4 route needs. `from`/`to` win over `window` when both are present.
 */
export const VIOLATION_WINDOWS = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 } as const;

export const ViolationListQueryDto = z
  .object({
    window: z.enum(['24h', '7d', '30d']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    driverId: z.string().uuid().optional(),
    type: z.enum(['DRIVING_11', 'SHIFT_14', 'BREAK_30', 'CYCLE_70', 'CYCLE_60', 'FORM_MANNER']).optional(),
    /** Defaults to OPEN — the W-01 KPI counts open violations (web/tz.md §W-01 KPI 3). */
    status: z.enum(['OPEN', 'RESOLVED', 'AUTO_CLEARED', 'ALL']).default('OPEN'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(25),
  })
  .refine((q) => !(q.from && q.to) || q.from <= q.to, { message: '`from` must not be after `to`.', path: ['from'] });
export type ViolationListQueryDto = z.infer<typeof ViolationListQueryDto>;

/** Same 4-60 character bound as every other RODS annotation (§395 Appendix A, §9.3). */
export const ResolveViolationDto = z.object({
  resolutionNote: z.string().trim().min(4).max(60),
});
export type ResolveViolationDto = z.infer<typeof ResolveViolationDto>;
