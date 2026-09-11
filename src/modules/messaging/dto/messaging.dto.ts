import { z } from 'zod';

export const ConversationTypeEnum = z.enum(['DIRECT', 'GROUP', 'BROADCAST']);

/** TZ §11.5 `POST /conversations` — "Messages" sidebar entry / "Message — chatni ochadi". */
export const CreateConversationDto = z.object({
  type: ConversationTypeEnum.default('DIRECT'),
  title: z.string().max(200).optional(),
  /** driverIds and/or userIds to add as participants, besides the creator. */
  driverIds: z.array(z.string().uuid()).max(500).default([]),
  userIds: z.array(z.string().uuid()).max(500).default([]),
});
export type CreateConversationDto = z.infer<typeof CreateConversationDto>;

export const SendMessageDto = z.object({
  body: z.string().min(1).max(2000),
  attachmentId: z.string().max(200).optional(),
  clientId: z.string().max(100).optional(),
});
export type SendMessageDto = z.infer<typeof SendMessageDto>;

/** TZ §11.5 `POST /messages/broadcast` — one message fanned out to many recipients. */
export const BroadcastMessageDto = z.object({
  title: z.string().max(200).optional(),
  body: z.string().min(1).max(2000),
  driverIds: z.array(z.string().uuid()).min(1).max(1000),
});
export type BroadcastMessageDto = z.infer<typeof BroadcastMessageDto>;
