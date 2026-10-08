import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { ListMessagesQueryDto, MobileSendMessageDto, StartConversationDto } from './dto/mobile-messaging.dto';
import { MobileMessagingService } from './mobile-messaging.service';

/**
 * TZ §11.5 / mobile.tz §7.5 (screen S-14) — MB-15. Driver token only; `messaging.controller.ts`
 * (the web/back-office contract) is untouched — this is a NEW route tree under `mobile`.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile/conversations')
export class MobileMessagingController {
  constructor(private readonly service: MobileMessagingService) {}

  @Get()
  @ApiOperation({ summary: 'Lists the driver\'s conversations with the last message and unread count (S-14).' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'cnv_1', type: 'DIRECT', title: 'Jane Dispatcher', participants: [{ id: 'drv_1', type: 'DRIVER', name: 'John Smith' }, { id: 'usr_1', type: 'STAFF', name: 'Jane Dispatcher' }], lastMessage: { id: 'msg_1', body: 'On schedule.', senderId: 'usr_1', senderType: 'STAFF', senderName: 'Jane Dispatcher', readAt: null, clientId: null }, unreadCount: 2 }] } } })
  @ApiStandardErrors()
  listConversations(@CurrentUser('id') driverId: string) {
    return this.service.listConversations(driverId);
  }

  @Post()
  @ApiOperation({
    summary: 'MR-3 — starts (or reuses) a conversation with a contact from `GET /mobile/contacts` and sends the first message.',
    description:
      '`contactId` is a staff user id, the active co-driver id, or `"support"`. An existing DIRECT conversation with that contact is reused. ' +
      'Idempotent on `clientId` (uuid, required): a replay returns the first response. The thread shows in the admin panel conversations list; ' +
      'a `conversation.new` realtime event goes to the staff contact\'s `user:{id}` room and `message.new` to `conversation:{id}`.',
  })
  @ApiBody({ schema: { example: { contactId: 'f3b1c2d4-0000-4000-8000-000000000001', body: 'Running 20 min late.', clientId: '0b9d6f5e-0000-4000-8000-000000000002' } } })
  @ApiCreatedResponse({
    schema: { example: { conversationId: 'cnv_1', message: { id: 'msg_1', body: 'Running 20 min late.', sentAt: '2026-10-08T15:00:00.000Z', senderId: 'drv_1', senderType: 'DRIVER', clientId: '0b9d6f5e-0000-4000-8000-000000000002' } } },
  })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Contact not found.')] })
  startConversation(@Body(zodBody(StartConversationDto)) dto: StartConversationDto, @CurrentUser() actor: ContextUser) {
    return this.service.startConversation(actor.id, dto, actor);
  }

  @Get(':id/messages')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'before', required: false })
  @ApiOperation({ summary: 'Cursor-paginated message history for a conversation the driver participates in.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'msg_1', body: 'On schedule.', sentAt: '2026-09-11T15:00:00.000Z', senderId: 'usr_1', senderType: 'STAFF', senderName: 'Jane Dispatcher', readAt: null, clientId: null }], limit: 50 } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Conversation not found.'),
      apiError.forbidden('Not a participant of this conversation.'),
    ],
  })
  listMessages(
    @Param('id') id: string,
    @Query(zodBody(ListMessagesQueryDto)) query: ListMessagesQueryDto,
    @CurrentUser('id') driverId: string,
  ) {
    return this.service.listMessages(id, driverId, query);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Sends a message into a conversation the driver participates in (fires realtime message.new). Idempotent on clientId: a replay returns the stored message.' })
  @ApiCreatedResponse({ schema: { example: { id: 'msg_2', body: 'Confirmed.', sentAt: '2026-09-11T15:05:00.000Z' } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Conversation not found.'),
      apiError.forbidden('Not a participant of this conversation.'),
    ],
  })
  sendMessage(@Param('id') id: string, @Body(zodBody(MobileSendMessageDto)) dto: MobileSendMessageDto, @CurrentUser() actor: ContextUser) {
    return this.service.sendMessage(id, dto, actor);
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marks the conversation read: sets the driver\'s lastReadAt and readAt on the other side\'s messages.' })
  @ApiOkResponse({ schema: { example: { messagesMarked: 3 } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Conversation not found.'),
      apiError.forbidden('Not a participant of this conversation.'),
    ],
  })
  markRead(@Param('id') id: string, @CurrentUser('id') driverId: string) {
    return this.service.markRead(id, driverId);
  }
}
