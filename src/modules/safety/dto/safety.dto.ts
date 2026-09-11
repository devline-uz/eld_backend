import { z } from 'zod';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

export const CoachingStatusEnum = z.enum(['NEW', 'REVIEWED', 'COACHED', 'DISMISSED']);
export const SafetyEventTypeEnum = z.enum(['HARSH_BRAKING', 'HARSH_ACCEL', 'HARSH_TURN', 'SPEEDING', 'SEATBELT']);

export const SafetyEventListQueryDto = ListQueryDto.extend({
  driverId: z.string().uuid().optional(),
  vehicleId: z.string().uuid().optional(),
  type: SafetyEventTypeEnum.optional(),
  status: CoachingStatusEnum.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type SafetyEventListQueryDto = z.infer<typeof SafetyEventListQueryDto>;

/** TZ eld.docs/web §9 — "Driver scorecard, Assign coaching orqali o'quv tayinlanadi". */
export const AssignCoachingDto = z.object({
  eventId: z.string().uuid(),
  note: z.string().max(1000).optional(),
});
export type AssignCoachingDto = z.infer<typeof AssignCoachingDto>;

export const UpdateSafetyEventDto = z.object({
  status: CoachingStatusEnum,
  coachingNote: z.string().max(1000).optional(),
});
export type UpdateSafetyEventDto = z.infer<typeof UpdateSafetyEventDto>;

export const ScorecardQueryDto = z.object({
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
});
export type ScorecardQueryDto = z.infer<typeof ScorecardQueryDto>;
