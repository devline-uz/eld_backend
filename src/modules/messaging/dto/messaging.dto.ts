import { z } from 'zod';
import { MESSAGE_AUDIO_MAX_DURATION_MS } from '../message-audio';

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

/** MB-9 — `body` may be empty only when an `attachmentId` (CHAT_AUDIO/CHAT_FILE upload) is sent. */
export const SendMessageDto = z
  .object({
    body: z.string().max(2000).default(''),
    attachmentId: z.string().max(200).optional(),
    clientId: z.string().max(100).optional(),
  })
  .refine((v) => v.body.trim().length > 0 || !!v.attachmentId, { path: ['body'], message: 'body or attachmentId is required.' });
export type SendMessageDto = z.infer<typeof SendMessageDto>;

/** Voice messages — the text fields of the multipart `POST /conversations/:id/messages/audio`
 * (the clip itself is the `file` part). Multipart fields arrive as strings, hence the coercion. */
export const SendAudioMessageDto = z.object({
  durationMs: z.coerce.number().int().min(0).max(MESSAGE_AUDIO_MAX_DURATION_MS).optional(),
  clientId: z.string().max(100).optional(),
});
export type SendAudioMessageDto = z.infer<typeof SendAudioMessageDto>;

/** TZ §11.5 `POST /messages/broadcast` — one message fanned out to many recipients. */
export const BroadcastMessageDto = z.object({
  title: z.string().max(200).optional(),
  body: z.string().min(1).max(2000),
  driverIds: z.array(z.string().uuid()).min(1).max(1000),
});
export type BroadcastMessageDto = z.infer<typeof BroadcastMessageDto>;

/** MB-9 — multipart fields of `POST /conversations/attachments` (the file part is read by multer). */
export const UploadChatAttachmentDto = z.object({
  kind: z.enum(['CHAT_AUDIO', 'CHAT_FILE']),
  durationSec: z.coerce.number().int().min(0).max(86400).optional(),
});
export type UploadChatAttachmentDto = z.infer<typeof UploadChatAttachmentDto>;
