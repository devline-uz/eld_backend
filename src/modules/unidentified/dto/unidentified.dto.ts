import { z } from 'zod';
import { CalendarDateQuerySchema } from '../../../common/dto/calendar-day.dto';
import { MAX_LIST_PAGE } from '../../../common/dto/list-query.dto';

/** §395 Appendix A — 60 characters, and §9.3's 4-character floor for a meaningful annotation. */
const annotation = z.string().trim().min(4).max(60);

export const UnidentifiedListQueryDto = z.object({
  status: z.enum(['PENDING', 'PENDING_CONFIRMATION', 'ASSIGNED', 'REJECTED', 'ANNOTATED', 'ALL']).default('PENDING'),
  vehicleId: z.string().uuid().optional(),
  // B3-14 — a real calendar day (no 02-30 roll-over), and `from` ≤ `to`.
  from: CalendarDateQuerySchema.optional(),
  to: CalendarDateQuerySchema.optional(),
  page: z.coerce.number().int().min(1).max(MAX_LIST_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
}).refine((q) => !(q.from && q.to) || q.from <= q.to, { message: '`from` must not be after `to`.', path: ['from'] });
export type UnidentifiedListQueryDto = z.infer<typeof UnidentifiedListQueryDto>;

export const AssignUnidentifiedDto = z.object({
  driverId: z.string().uuid(),
  annotation: annotation.optional(),
  /**
   * B-83 / CODE-029 — driver confirmation is mandatory: every carrier assignment goes to
   * `PENDING_CONFIRMATION` and the records move to the driver's log only when they confirm
   * (`POST /unidentified/:id/confirm`). Kept for older clients; `false` is refused (422).
   */
  requireDriverConfirmation: z.literal(true).optional(),
});
export type AssignUnidentifiedDto = z.infer<typeof AssignUnidentifiedDto>;

export const AnnotateUnidentifiedDto = z.object({ annotation });
export type AnnotateUnidentifiedDto = z.infer<typeof AnnotateUnidentifiedDto>;

export const RejectUnidentifiedDto = z.object({ reason: annotation.optional() });
export type RejectUnidentifiedDto = z.infer<typeof RejectUnidentifiedDto>;

/** §7.4 rule 2 — the driver's answer to "was this you?". */
export const ConfirmUnidentifiedDto = z.object({
  accept: z.boolean(),
  annotation: annotation.optional(),
});
export type ConfirmUnidentifiedDto = z.infer<typeof ConfirmUnidentifiedDto>;
