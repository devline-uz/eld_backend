import { z } from 'zod';

/** §395 Appendix A caps every annotation/comment at 60 characters; the floor of 4 is §9.3. */
export const annotationSchema = z.string().trim().min(4).max(60);

const dayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const isoDateTime = z.coerce.date();

export const DutyStatusEnum = z.enum(['OFF', 'SB', 'D', 'ON']);
/** §9.3 — a driver may only move between OFF / SB / ON. `D` is rejected by the rule engine. */
export const SelfEditStatusEnum = z.enum(['OFF', 'SB', 'ON']);

export const LogDateQueryDto = z.object({ date: dayKeySchema.optional() });
export type LogDateQueryDto = z.infer<typeof LogDateQueryDto>;

export const LogRangeQueryDto = z
  .object({ from: dayKeySchema, to: dayKeySchema })
  .refine((value) => value.from <= value.to, { message: '`from` must not be after `to`' });
export type LogRangeQueryDto = z.infer<typeof LogRangeQueryDto>;

export const LocationDto = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  name: z.string().max(120).optional(),
});

/** TZ §9.1 — the carrier's §395.30 edit proposal. */
export const CreateEditRequestDto = z.object({
  originalEventId: z.string().regex(/^\d+$/, 'Expected an event id'),
  proposedStatus: DutyStatusEnum,
  proposedStart: isoDateTime,
  proposedEnd: isoDateTime.optional(),
  location: LocationDto.optional(),
  odometerMi: z.number().int().min(0).max(9_999_999).optional(),
  engineHours: z.number().min(0).max(99_999).optional(),
  reason: annotationSchema,
});
export type CreateEditRequestDto = z.infer<typeof CreateEditRequestDto>;

export const ResolveEditRequestDto = z.object({ note: annotationSchema.optional() });
export type ResolveEditRequestDto = z.infer<typeof ResolveEditRequestDto>;

/** TZ §9.2 — certification of one or more RODS days. */
export const CertifyDto = z.object({
  dates: z.array(dayKeySchema).min(1).max(31),
  signatureImageId: z.string().max(200).optional(),
  /** Back office only, and only with `hosCertifyOnBehalf = FULL` (§9.2). */
  driverId: z.string().uuid().optional(),
});
export type CertifyDto = z.infer<typeof CertifyDto>;

/** TZ §9.3 — `POST /mobile/log-entries`, the driver's own correction. */
export const CreateLogEntryDto = z.object({
  date: dayKeySchema.optional(),
  status: SelfEditStatusEnum,
  startAt: isoDateTime,
  endAt: isoDateTime.optional(),
  annotation: annotationSchema,
  location: LocationDto.optional(),
  odometerMi: z.number().int().min(0).max(9_999_999).optional(),
  /** Set when the entry corrects an existing record rather than adding a missing one. */
  originalEventId: z.string().regex(/^\d+$/).optional(),
});
export type CreateLogEntryDto = z.infer<typeof CreateLogEntryDto>;

export const EditRequestListQueryDto = z.object({
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'ALL']).default('PENDING'),
  from: dayKeySchema.optional(),
  to: dayKeySchema.optional(),
});
export type EditRequestListQueryDto = z.infer<typeof EditRequestListQueryDto>;
