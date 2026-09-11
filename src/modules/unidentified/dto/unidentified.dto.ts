import { z } from 'zod';

/** §395 Appendix A — 60 characters, and §9.3's 4-character floor for a meaningful annotation. */
const annotation = z.string().trim().min(4).max(60);

export const UnidentifiedListQueryDto = z.object({
  status: z.enum(['PENDING', 'ASSIGNED', 'REJECTED', 'ANNOTATED', 'ALL']).default('PENDING'),
  vehicleId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});
export type UnidentifiedListQueryDto = z.infer<typeof UnidentifiedListQueryDto>;

export const AssignUnidentifiedDto = z.object({
  driverId: z.string().uuid(),
  annotation: annotation.optional(),
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
