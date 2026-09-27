import { z } from 'zod';

/** MB-15 — `GET /mobile/conversations/:id/messages?limit&before`. Cursor pagination: `before`
 *  is the id of a message already seen by the app, results are strictly older. */
export const ListMessagesQueryDto = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().uuid().optional(),
});
export type ListMessagesQueryDto = z.infer<typeof ListMessagesQueryDto>;

/** MB-15 — `POST /mobile/conversations/:id/messages`. Same shape as `SendMessageDto`
 *  (`messaging/dto/messaging.dto.ts`), duplicated here rather than imported so the mobile
 *  and web contracts can diverge independently without either agent touching the other's file. */
export const MobileSendMessageDto = z.object({
  body: z.string().min(1).max(2000),
  attachmentId: z.string().max(200).optional(),
  clientId: z.string().max(100).optional(),
});
export type MobileSendMessageDto = z.infer<typeof MobileSendMessageDto>;
