import { Body, Controller, Get, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { z } from 'zod';
import type { ContextUser } from '../../core/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { BroadcastMessageDto, UploadChatAttachmentDto, CreateConversationDto, SendMessageDto } from './dto/messaging.dto';
import { ChatAttachmentsService, MAX_CHAT_ATTACHMENT_BYTES } from '../attachments/chat-attachments.service';
import { MessagingService } from './messaging.service';

const PageQueryDto = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) });

/** TZ §11.5 — chat and broadcast, gated by `messaging`. */
@FigmaScreen('web/messages')
@ApiTags('messaging')
@ApiBearerAuth()
@Controller()
export class MessagingController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly chatAttachments: ChatAttachmentsService,
  ) {}

  @Get('conversations')
  @Perm('messaging', 'READ')
  @ApiOperation({ summary: 'Lists the caller\'s conversations.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'cnv_1', type: 'DIRECT', lastMessageAt: '2026-09-11T15:00:00.000Z' }] } } })
  @ApiStandardErrors()
  listConversations(@CurrentUser() actor: ContextUser) {
    return this.messaging.listConversations(actor);
  }

  @Post('conversations')
  @Perm('messaging', 'FULL')
  @Audit({ object: 'Conversation', action: 'CREATE' })
  @ApiOperation({ summary: 'Opens a direct or group conversation with the given participants.' })
  @ApiCreatedResponse({ schema: { example: { id: 'cnv_2', type: 'DIRECT' } } })
  @ApiStandardErrors()
  createConversation(@Body(zodBody(CreateConversationDto)) dto: CreateConversationDto, @CurrentUser() actor: ContextUser) {
    return this.messaging.createConversation(dto, actor);
  }

  @Post('conversations/attachments')
  @Perm('messaging', 'FULL')
  @Audit({ object: 'Attachment', action: 'CREATE' })
  // Multer enforces the 10 MB cap while streaming (413 past it) — same pattern as the avatar upload.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_CHAT_ATTACHMENT_BYTES, files: 1, fields: 5, parts: 6 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'kind'],
      properties: {
        file: { type: 'string', format: 'binary' },
        kind: { type: 'string', enum: ['CHAT_AUDIO', 'CHAT_FILE'] },
        durationSec: { type: 'integer', description: 'Voice-message length, CHAT_AUDIO only.' },
      },
    },
  })
  @ApiOperation({
    summary: 'MB-9 — uploads a chat voice message (AAC/M4A) or file (PNG/JPEG/PDF), max 10 MB; returns the attachment id to pass as `attachmentId` to POST /conversations/:id/messages.',
    description: 'Type is verified from the file\'s magic bytes, not the declared Content-Type. Stored under `chat/carrier/{uploaderId}/`. Read back via `GET /attachments/:id/presign` (conversation participants only).',
  })
  @ApiCreatedResponse({ schema: { example: { id: 'att_1', attachmentId: 'att_1', kind: 'CHAT_AUDIO', mimeType: 'audio/mp4', sizeBytes: 48211, durationSec: 12 } } })
  @ApiStandardErrors({
    errors: [
      apiError.unprocessable(ERROR_CODES.UNSUPPORTED_FILE_TYPE, 'Type not allowed for this kind, or content does not match the declared type.'),
      apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'Missing file, empty file or invalid kind.'),
    ],
  })
  async uploadAttachment(
    @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined,
    @Body(zodBody(UploadChatAttachmentDto)) dto: UploadChatAttachmentDto,
    @CurrentUser() actor: ContextUser,
  ) {
    if (!file) throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'file is required.', 422, { file: 'Required.' });
    const { key: _key, sha256: _sha, ...view } = await this.chatAttachments.store({ buffer: file.buffer, mimeType: file.mimetype, kind: dto.kind, durationSec: dto.durationSec, uploader: actor });
    return view;
  }

  @Get('conversations/:id/messages')
  @Perm('messaging', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOperation({ summary: 'Lists messages in a conversation (caller must be a participant).' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'msg_1', body: 'On schedule.', type: 'TEXT', attachment: null, sentAt: '2026-09-11T15:00:00.000Z' }], page: 1, limit: 50, total: 1, totalPages: 1 } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Conversation not found.'),
      apiError.forbidden('Not a participant of this conversation.'),
    ],
  })
  listMessages(@Param('id') id: string, @Query(zodBody(PageQueryDto)) query: { page: number; limit: number }, @CurrentUser() actor: ContextUser) {
    return this.messaging.listMessages(id, actor, query.page, query.limit);
  }

  @Post('conversations/:id/messages')
  @Perm('messaging', 'FULL')
  @Audit({ object: 'Message', action: 'CREATE' })
  @ApiOperation({ summary: 'Sends a message into a conversation. MB-9: `body` may be empty when `attachmentId` (from POST /conversations/attachments) is given; the message carries `type` TEXT|AUDIO|IMAGE|FILE and `attachment{id,url,mimeType,sizeBytes,durationSec}`.' })
  @ApiCreatedResponse({ schema: { example: { id: 'msg_2', body: 'Confirmed.', sentAt: '2026-09-11T15:05:00.000Z' } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Conversation not found.'),
      apiError.forbidden('Not a participant of this conversation.'),
    ],
  })
  sendMessage(@Param('id') id: string, @Body(zodBody(SendMessageDto)) dto: SendMessageDto, @CurrentUser() actor: ContextUser) {
    return this.messaging.sendMessage(id, dto, actor);
  }

  @Post('conversations/:id/read')
  @Perm('messaging', 'FULL')
  @Audit({ object: 'Conversation', action: 'READ' })
  @ApiOperation({ summary: "Marks the caller's own copy of a conversation read up to now (§20 B-67)." })
  @ApiOkResponse({ schema: { example: { conversationId: 'cnv_1', lastReadAt: '2026-09-24T15:05:00.000Z' } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Conversation not found.'),
      apiError.forbidden('Not a participant of this conversation.'),
    ],
  })
  markRead(@Param('id') id: string, @CurrentUser() actor: ContextUser) {
    return this.messaging.markRead(id, actor);
  }

  @Post('messages/broadcast')
  @Perm('messaging', 'FULL')
  @Audit({ object: 'Message', action: 'BROADCAST' })
  @ApiOperation({ summary: 'Broadcasts one message to many drivers (one conversation + delivery per driver).' })
  @ApiOkResponse({ schema: { example: { sent: 2, deliveries: [{ conversationId: 'cnv_3', messageId: 'msg_3', driverId: 'drv_1' }] } } })
  @ApiStandardErrors()
  broadcast(@Body(zodBody(BroadcastMessageDto)) dto: BroadcastMessageDto, @CurrentUser() actor: ContextUser) {
    return this.messaging.broadcast(dto, actor);
  }
}
