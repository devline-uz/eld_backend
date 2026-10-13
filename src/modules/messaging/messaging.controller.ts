import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { z } from 'zod';
import { MAX_LIST_PAGE } from '../../common/dto/list-query.dto';
import type { ContextUser } from '../../core/context/request-context';
import {
  BroadcastMessageDto,
  CreateConversationDto,
  SendAudioMessageDto,
  SendMessageDto,
} from './dto/messaging.dto';
import { MESSAGE_AUDIO_MAX_BYTES } from './message-audio';
import { MessagingService, UploadedAudioFile } from './messaging.service';

const PageQueryDto = z.object({
  page: z.coerce.number().int().min(1).max(MAX_LIST_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** TZ §11.5 — chat and broadcast, gated by `messaging`. */
@FigmaScreen('web/messages')
@ApiTags('messaging')
@ApiBearerAuth()
@Controller()
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Get('conversations')
  @Perm('messaging', 'READ')
  @ApiOperation({ summary: "Lists the caller's conversations." })
  @ApiOkResponse({
    schema: {
      example: {
        items: [{ id: 'cnv_1', type: 'DIRECT', lastMessageAt: '2026-09-11T15:00:00.000Z' }],
      },
    },
  })
  @ApiStandardErrors()
  listConversations(@CurrentUser() actor: ContextUser) {
    return this.messaging.listConversations(actor);
  }

  @Post('conversations')
  @Perm('messaging', 'FULL')
  @Audit({ object: 'Conversation', action: 'CREATE' })
  @ApiOperation({ summary: 'Opens a direct or group conversation with the given participants.' })
  @ApiCreatedResponse({
    description:
      'Created. For type DIRECT an existing conversation between the two participants is returned instead of creating a duplicate.',
    schema: { example: { id: 'cnv_2', type: 'DIRECT' } },
  })
  @ApiStandardErrors({
    errors: [
      {
        ...apiError.validation('A direct conversation needs exactly one other participant.'),
        details: { driverIds: 'A direct conversation needs exactly one other participant.' },
        description:
          'VALIDATION_FAILED — wrong participant count for the conversation type (DIRECT needs exactly one other participant; at least one participant otherwise) or unknown recipients (details.driverIds).',
      },
    ],
  })
  createConversation(
    @Body(zodBody(CreateConversationDto)) dto: CreateConversationDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.messaging.createConversation(dto, actor);
  }

  @Get('conversations/:id/messages')
  @Perm('messaging', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOperation({ summary: 'Lists messages in a conversation (caller must be a participant).' })
  @ApiOkResponse({
    schema: {
      example: {
        items: [{ id: 'msg_1', body: 'On schedule.', sentAt: '2026-09-11T15:00:00.000Z' }],
        page: 1,
        limit: 50,
        total: 1,
        totalPages: 1,
      },
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Conversation not found.'),
      apiError.forbidden('Not a participant of this conversation.'),
    ],
  })
  listMessages(
    @Param('id') id: string,
    @Query(zodBody(PageQueryDto)) query: { page: number; limit: number },
    @CurrentUser() actor: ContextUser,
  ) {
    return this.messaging.listMessages(id, actor, query.page, query.limit);
  }

  @Post('conversations/:id/messages')
  @Perm('messaging', 'FULL')
  @Audit({ object: 'Message', action: 'CREATE' })
  @ApiOperation({ summary: 'Sends a message into a conversation.' })
  @ApiCreatedResponse({
    schema: { example: { id: 'msg_2', body: 'Confirmed.', sentAt: '2026-09-11T15:05:00.000Z' } },
  })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Conversation not found.'),
      apiError.forbidden('Not a participant of this conversation.'),
    ],
  })
  sendMessage(
    @Param('id') id: string,
    @Body(zodBody(SendMessageDto)) dto: SendMessageDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.messaging.sendMessage(id, dto, actor);
  }

  @Post('conversations/:id/messages/audio')
  @Perm('messaging', 'FULL')
  @Audit({ object: 'Message', action: 'CREATE' })
  // The size limit is enforced while multer streams the part (413 past the cap), not after buffering.
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MESSAGE_AUDIO_MAX_BYTES, files: 1, fields: 5, parts: 6 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description:
            'The recorded clip: audio/webm, audio/ogg, audio/mp4 (m4a), audio/mpeg, audio/aac or audio/wav; max 10 MB.',
        },
        durationMs: {
          type: 'integer',
          minimum: 0,
          maximum: 300000,
          description: 'Clip length in milliseconds (max 5 min).',
        },
        clientId: {
          type: 'string',
          maxLength: 100,
          description:
            'Idempotency key — a retry with the same clientId returns the stored message.',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Sends a voice message into a conversation.',
    description:
      'Creates an AUDIO message (`type: "AUDIO"`, `body: "Voice message"` as a plain-text fallback) whose `attachment` carries the clip metadata `{ id, kind, mimeType, sizeBytes, durationMs }`; resolve it to a playable 15-minute URL with GET /attachments/:id/presign (any conversation participant may). Pushed as `message.new` like a text message.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'msg_3',
        type: 'AUDIO',
        body: 'Voice message',
        attachmentId: 'att_9',
        sentAt: '2026-10-13T10:00:00.000Z',
        attachment: {
          id: 'att_9',
          kind: 'AUDIO',
          mimeType: 'audio/webm',
          sizeBytes: 48211,
          durationMs: 5300,
        },
      },
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Conversation not found.'),
      apiError.forbidden('Not a participant of this conversation.'),
      apiError.unprocessable(
        ERROR_CODES.UNSUPPORTED_FILE_TYPE,
        'Voice message must be WebM, Ogg, MP4/M4A, MP3, AAC or WAV audio.',
      ),
      {
        status: 422,
        code: ERROR_CODES.FILE_TOO_LARGE,
        message: 'Voice messages must be under 10 MB.',
      },
    ],
  })
  sendAudioMessage(
    @Param('id') id: string,
    @UploadedFile() file: UploadedAudioFile | undefined,
    @Body(zodBody(SendAudioMessageDto)) dto: SendAudioMessageDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.messaging.sendAudioMessage(id, file, dto, actor);
  }

  @Post('conversations/:id/read')
  @Perm('messaging', 'FULL')
  @Audit({ object: 'Conversation', action: 'READ' })
  @ApiOperation({
    summary: "Marks the caller's own copy of a conversation read up to now (§20 B-67).",
  })
  @ApiOkResponse({
    schema: { example: { conversationId: 'cnv_1', lastReadAt: '2026-09-24T15:05:00.000Z' } },
  })
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
  @ApiOperation({
    summary: 'Broadcasts one message to many drivers (one conversation + delivery per driver).',
  })
  @ApiOkResponse({
    schema: {
      example: {
        sent: 2,
        deliveries: [{ conversationId: 'cnv_3', messageId: 'msg_3', driverId: 'drv_1' }],
      },
    },
  })
  @ApiStandardErrors()
  broadcast(
    @Body(zodBody(BroadcastMessageDto)) dto: BroadcastMessageDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.messaging.broadcast(dto, actor);
  }
}
