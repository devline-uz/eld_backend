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

/**
 * B-39 — a carrier proposal may correct the location by NAME only (a dispatcher rarely has
 * coordinates). Coordinates are optional but come as a pair; with none, `name` is required.
 */
export const ProposalLocationDto = z
  .object({
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .refine((value) => (value.lat === undefined) === (value.lon === undefined), {
    message: '`lat` and `lon` must be sent together',
  })
  .refine((value) => value.lat !== undefined || Boolean(value.name), {
    message: 'A location needs `name` or `lat`/`lon`',
  });
export type ProposalLocationDto = z.infer<typeof ProposalLocationDto>;

/**
 * B-39 — §395.1(e) special driving category of a proposal. Personal conveyance is an OFF-duty
 * category and yard move an ON-duty one (Appendix A eventType 3, codes 1/2), so the base
 * status must match: PC ⇒ OFF, YM ⇒ ON.
 */
export const ProposedSpecialEnum = z.enum(['NONE', 'PC', 'YM']);
export type ProposedSpecial = z.infer<typeof ProposedSpecialEnum>;

function checkSpecial(status: string, special: ProposedSpecial | undefined, ctx: z.RefinementCtx, path: string): void {
  if (special === 'PC' && status !== 'OFF') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: 'Personal conveyance (PC) requires status OFF (§395.1(e)(1))' });
  }
  if (special === 'YM' && status !== 'ON') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: 'Yard move (YM) requires status ON (§395.1(e)(2))' });
  }
}

/** TZ §9.1 — the carrier's §395.30 edit proposal. */
export const CreateEditRequestDto = z
  .object({
    originalEventId: z.string().regex(/^\d+$/, 'Expected an event id'),
    proposedStatus: DutyStatusEnum,
    /** B-39 — PC/YM; stored as the Appendix A eventType 3 indication once the driver accepts. */
    proposedSpecial: ProposedSpecialEnum.default('NONE'),
    proposedStart: isoDateTime,
    proposedEnd: isoDateTime.optional(),
    location: ProposalLocationDto.optional(),
    odometerMi: z.number().int().min(0).max(9_999_999).optional(),
    engineHours: z.number().min(0).max(99_999).optional(),
    reason: annotationSchema,
    /** B-39 — `false` suppresses the push only; the proposal still waits in the driver app. */
    notifyDriver: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    checkSpecial(value.proposedStatus, value.proposedSpecial, ctx, 'proposedSpecial');
    if (value.proposedEnd && value.proposedEnd.getTime() <= value.proposedStart.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['proposedEnd'], message: '`proposedEnd` must be after `proposedStart`' });
    }
  });
/** Input shape: `proposedSpecial` / `notifyDriver` may be absent when called in-process (defaults applied by the service). */
export type CreateEditRequestDto = z.input<typeof CreateEditRequestDto>;

/**
 * B-72 — `POST /logs/:driverId/events`: the carrier proposes a NEW record (typically on a RODS
 * day with no duty record yet). Same §395.30 flow as an edit request: stored inert
 * (`recordStatus = 3`), applied only when the driver accepts.
 */
export const ProposeEventDto = z
  .object({
    status: DutyStatusEnum,
    proposedSpecial: ProposedSpecialEnum.default('NONE'),
    eventDateTime: isoDateTime,
    endDateTime: isoDateTime.optional(),
    location: ProposalLocationDto.optional(),
    odometerMi: z.number().int().min(0).max(9_999_999).optional(),
    engineHours: z.number().min(0).max(99_999).optional(),
    annotation: annotationSchema,
    notifyDriver: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    checkSpecial(value.status, value.proposedSpecial, ctx, 'proposedSpecial');
    if (value.endDateTime && value.endDateTime.getTime() <= value.eventDateTime.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDateTime'], message: '`endDateTime` must be after `eventDateTime`' });
    }
  });
export type ProposeEventDto = z.input<typeof ProposeEventDto>;

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

/** mobile/tz.md MB-18 — `GET /mobile/logs/:date/export?format=csv|pdf`. */
export const LogExportDateParamDto = z.object({ date: dayKeySchema });
export type LogExportDateParamDto = z.infer<typeof LogExportDateParamDto>;
export const LogExportFormatQueryDto = z.object({ format: z.enum(['csv', 'pdf']).default('csv') });
export type LogExportFormatQueryDto = z.infer<typeof LogExportFormatQueryDto>;
