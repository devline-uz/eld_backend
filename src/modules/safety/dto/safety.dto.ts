import { z } from 'zod';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

export const CoachingStatusEnum = z.enum(['NEW', 'REVIEWED', 'COACHED', 'DISMISSED']);
export const SafetyEventTypeEnum = z.enum(['HARSH_BRAKING', 'HARSH_ACCEL', 'HARSH_TURN', 'SPEEDING', 'SEATBELT']);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day: `2026-13-45` / `2026-02-31` are refused instead of rolling over (CODE-073). */
function isCalendarDay(value: string): boolean {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

/** An instant, or a calendar day. `end` turns a day into its last millisecond (inclusive end). */
const boundary = (end: boolean) =>
  z
    .string()
    .trim()
    .refine((value) => (DATE_ONLY.test(value) ? isCalendarDay(value) : !Number.isNaN(Date.parse(value))), 'Not a valid date')
    .transform((value) =>
      DATE_ONLY.test(value) && end
        ? new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000 - 1)
        : new Date(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value),
    );

/** CODE-073 — the sortable columns of the events list (`sort=field:asc|desc`). */
export const SAFETY_EVENT_SORT_FIELDS = ['occurredAt', 'severity', 'type', 'status'] as const;

export const SafetyEventListQueryDto = ListQueryDto.extend({
  driverId: z.string().uuid().optional(),
  vehicleId: z.string().uuid().optional(),
  type: SafetyEventTypeEnum.optional(),
  status: CoachingStatusEnum.optional(),
  from: boundary(false).optional(),
  /** A date-only `to` includes that whole day (it used to stop at its 00:00). */
  to: boundary(true).optional(),
}).refine((v) => !v.from || !v.to || v.from.getTime() <= v.to.getTime(), {
  message: '`from` must not be after `to`',
  path: ['to'],
});
export type SafetyEventListQueryDto = z.infer<typeof SafetyEventListQueryDto>;

/**
 * TZ eld.docs/web §9 — "Driver scorecard, Assign coaching orqali o'quv tayinlanadi". §20 B-43 —
 * coaching can be assigned directly at the driver level (`driverId`, e.g. from the scorecard row)
 * without first picking a specific event; `eventId` is still accepted for the existing
 * event-driven flow. Exactly one of the two is required.
 */
export const AssignCoachingDto = z
  .object({
    eventId: z.string().uuid().optional(),
    driverId: z.string().uuid().optional(),
    note: z.string().max(1000).optional(),
  })
  .refine((v) => Boolean(v.eventId) !== Boolean(v.driverId), {
    message: 'Provide exactly one of eventId or driverId.',
  });
export type AssignCoachingDto = z.infer<typeof AssignCoachingDto>;

/**
 * CODE-072 — `PATCH /safety/events/:id` only REVIEWS or DISMISSES an event. COACHED goes through
 * `POST /safety/coaching` (which records the coach and the time); NEW is the detector's state.
 * A dismissal needs the reason in `coachingNote`; the acting user is in the audit row.
 */
export const UpdateSafetyEventDto = z
  .object({
    status: z.enum(['REVIEWED', 'DISMISSED']),
    coachingNote: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.status !== 'DISMISSED' || Boolean(v.coachingNote), {
    message: 'A dismissal needs a reason.',
    path: ['coachingNote'],
  });
export type UpdateSafetyEventDto = z.infer<typeof UpdateSafetyEventDto>;

/** D-141 — calendar days ("YYYY-MM-DD", home-terminal RODS days), never instants: a period is a
 * set of local days, so an ISO instant would re-introduce the B-056 time-zone shift. Both
 * optional; none = the latest computed period. */
const DayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').refine(isCalendarDay, 'Not a calendar date');
export const ScorecardQueryDto = z
  .object({
    periodStart: DayKey.optional(),
    periodEnd: DayKey.optional(),
  })
  .refine((v) => !v.periodStart || !v.periodEnd || v.periodStart <= v.periodEnd, {
    message: '`periodStart` must not be after `periodEnd`',
    path: ['periodEnd'],
  });
export type ScorecardQueryDto = z.infer<typeof ScorecardQueryDto>;
