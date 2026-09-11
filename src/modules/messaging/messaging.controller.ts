import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { z } from 'zod';
import type { ContextUser } from '../../core/context/request-context';
import { BroadcastMessageDto, CreateConversationDto, SendMessageDto } from './dto/messaging.dto';
import { MessagingService } from './messaging.service';

const PageQueryDto = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) });

/** TZ §11.5 — chat and broadcast, gated by `messaging`. */
@FigmaScreen('web/messages')
@ApiTags('messaging')
@ApiBearerAuth()
@Controller()
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

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

  @Get('conversations/:id/messages')
  @Perm('messaging', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOperation({ summary: 'Lists messages in a conversation (caller must be a participant).' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'msg_1', body: 'On schedule.', sentAt: '2026-09-11T15:00:00.000Z' }], page: 1, limit: 50, total: 1, totalPages: 1 } } })
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
  @ApiOperation({ summary: 'Sends a message into a conversation.' })
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
