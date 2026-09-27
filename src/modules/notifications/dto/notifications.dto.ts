import { z } from 'zod';

/** TZ §14 — `SMS` stays in the enum for a migration-free v2 add, but the API rejects it now. */
export const AlertChannelEnum = z.enum(['IN_APP', 'EMAIL', 'SMS', 'WEBHOOK']);
export const AlertSeverityEnum = z.enum(['CRITICAL', 'WARNING', 'INFO']);

const ThrottleDto = z.object({
  perDriverPerDay: z.number().int().positive().optional(),
  cooldownMin: z.number().int().positive().optional(),
});

const QuietHoursDto = z.object({
  from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm'),
  to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm'),
  timezone: z.string().min(1).max(60),
});

const ConditionDto = z.object({
  event: z.string().min(1).max(100),
  params: z.record(z.string(), z.unknown()).optional(),
});

const RecipientsDto = z.object({
  roles: z.array(z.string()).optional(),
  userIds: z.array(z.string().uuid()).optional(),
  driverIds: z.array(z.string().uuid()).optional(),
  /** true = the alert's own subject (driver on the triggering event) is also notified. */
  subjectDriver: z.boolean().optional(),
});

export const CreateAlertRuleDto = z.object({
  key: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  severity: AlertSeverityEnum,
  conditions: z.array(ConditionDto).min(1),
  channels: z.array(AlertChannelEnum).min(1),
  recipients: RecipientsDto,
  throttle: ThrottleDto.optional(),
  quietHours: QuietHoursDto.optional(),
  enabled: z.boolean().default(true),
});
export type CreateAlertRuleDto = z.infer<typeof CreateAlertRuleDto>;

export const UpdateAlertRuleDto = CreateAlertRuleDto.partial().omit({ key: true }).extend({
  /** §20 B-86 — "Mute for 24h" row menu; `null` clears the mute immediately. */
  mutedUntil: z.coerce.date().nullable().optional(),
});
export type UpdateAlertRuleDto = z.infer<typeof UpdateAlertRuleDto>;

/** §20 B-57 — the two segments the notifications panel renders. */
export const NotificationCategoryEnum = z.enum(['VIOLATIONS', 'MAINTENANCE']);

export const NotificationListQueryDto = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  unreadOnly: z.coerce.boolean().default(false),
  category: NotificationCategoryEnum.optional(),
});
export type NotificationListQueryDto = z.infer<typeof NotificationListQueryDto>;

/** §20 B-87 — `GET/PATCH /notification-channels` (org-level, `Carrier.notificationChannels`). */
export const NotificationChannelsDto = z.object({
  email: z.object({ enabled: z.boolean() }).optional(),
  webhook: z.object({ enabled: z.boolean(), url: z.string().url().optional() }).optional(),
});
export type NotificationChannelsDto = z.infer<typeof NotificationChannelsDto>;
