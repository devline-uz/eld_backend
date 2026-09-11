import { z } from 'zod';

export const TicketPriorityEnum = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export const TicketStatusEnum = z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);

/** TZ §5.10, §11.7 `POST /support/tickets` — "Settings > Support" Figma screen. */
export const CreateSupportTicketDto = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  category: z.string().max(100).optional(),
  priority: TicketPriorityEnum.default('NORMAL'),
});
export type CreateSupportTicketDto = z.infer<typeof CreateSupportTicketDto>;

export const UpdateSupportTicketDto = z.object({
  status: TicketStatusEnum.optional(),
  assignedToId: z.string().uuid().optional(),
  priority: TicketPriorityEnum.optional(),
});
export type UpdateSupportTicketDto = z.infer<typeof UpdateSupportTicketDto>;

export const SupportTicketListQueryDto = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(60).optional(),
  q: z.string().max(200).optional(),
  status: TicketStatusEnum.optional(),
  priority: TicketPriorityEnum.optional(),
});
export type SupportTicketListQueryDto = z.infer<typeof SupportTicketListQueryDto>;

/** TZ §11.7 `POST /feedback` — in-app feedback form (mobile + web). */
export const CreateFeedbackDto = z.object({
  answers: z.record(z.string(), z.unknown()),
  comment: z.string().max(1000).optional(),
  appVersion: z.string().max(40).optional(),
  platform: z.string().max(40).optional(),
});
export type CreateFeedbackDto = z.infer<typeof CreateFeedbackDto>;
