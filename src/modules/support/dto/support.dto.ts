import { z } from 'zod';

export const TicketPriorityEnum = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export const TicketStatusEnum = z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);

/** §20 B-91 — server-collected ticket attachments ("Include device diagnostics" / "Include the
 * last 24h of ELD events"). The client never builds the ELD event export itself. */
export const TicketAttachmentKindEnum = z.enum(['DEVICE_DIAGNOSTICS', 'ELD_EVENTS_24H']);

/** TZ §5.10, §11.7 `POST /support/tickets` — "Settings > Support" Figma screen. */
export const CreateSupportTicketDto = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  category: z.string().max(100).optional(),
  priority: TicketPriorityEnum.default('NORMAL'),
  /** Scopes the server-collected attachments below to one unit. Required when `attachments` is
   * non-empty (the server has no other way to know which device/vehicle to pull from). */
  vehicleId: z.string().uuid().optional(),
  attachments: z.array(z.object({ kind: TicketAttachmentKindEnum })).max(2).optional(),
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

/** §20 B-90 `POST /support/chats` — opens (or continues) a real-time support conversation;
 * reuses `Conversation`/`Message` (`ConversationType.SUPPORT`) and the existing socket room
 * plumbing (`conversation:{id}`) rather than a separate chat model. */
export const CreateSupportChatDto = z.object({
  subject: z.string().max(200).optional(),
  message: z.string().min(1).max(2000),
});
export type CreateSupportChatDto = z.infer<typeof CreateSupportChatDto>;

/** MR-20 — how the driver wants to be contacted about a ticket. */
export const ContactMethodEnum = z.enum(['EMAIL', 'PHONE']);

/** MR-20 — `POST /mobile/support/tickets`: the web contract plus `contactMethod` and an idempotency `clientId`. */
export const MobileCreateSupportTicketDto = CreateSupportTicketDto.extend({
  contactMethod: ContactMethodEnum.nullish(),
  clientId: z.string().uuid().optional(),
});
export type MobileCreateSupportTicketDto = z.infer<typeof MobileCreateSupportTicketDto>;

/** MR-28 — the 4-question in-app survey (mobile M-22). Each answer is the selected chip's
 * value (string) or a numeric score. Extra keys stay accepted (`catchall`) so older/newer app
 * versions and the web form keep working — only the known keys are type-checked. */
const FeedbackAnswer = z.union([z.string().max(200), z.number()]);
export const FeedbackAnswersDto = z
  .object({
    tenure: FeedbackAnswer.optional(),
    ease: FeedbackAnswer.optional(),
    hosSatisfaction: FeedbackAnswer.optional(),
    recommend: FeedbackAnswer.optional(),
    /** M-46 (wave 4) — overall experience star rating, integer 1-5. */
    overallExperience: z.number().int().min(1).max(5).optional(),
  })
  .catchall(z.unknown());
export type FeedbackAnswersDto = z.infer<typeof FeedbackAnswersDto>;

/** TZ §11.7 `POST /feedback` — in-app feedback form (mobile + web). */
export const CreateFeedbackDto = z.object({
  answers: FeedbackAnswersDto,
  /** MR-20 — idempotency key for offline replays (mobile endpoint). */
  clientId: z.string().uuid().optional(),
  comment: z.string().max(1000).optional(),
  appVersion: z.string().max(40).optional(),
  platform: z.string().max(40).optional(),
});
export type CreateFeedbackDto = z.infer<typeof CreateFeedbackDto>;
