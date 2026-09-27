import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { ListMessagesQueryDto, MobileSendMessageDto } from './dto/mobile-messaging.dto';
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
  @ApiOkResponse({ schema: { example: { items: [{ id: 'cnv_1', type: 'DIRECT', lastMessage: { id: 'msg_1', body: 'On schedule.' }, unreadCount: 2 }] } } })
  @ApiStandardErrors()
  listConversations(@CurrentUser('id') driverId: string) {
    return this.service.listConversations(driverId);
  }

  @Get(':id/messages')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'before', required: false })
  @ApiOperation({ summary: 'Cursor-paginated message history for a conversation the driver participates in.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'msg_1', body: 'On schedule.', sentAt: '2026-09-11T15:00:00.000Z' }], limit: 50 } } })
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
  @ApiOperation({ summary: 'Sends a message into a conversation the driver participates in (fires realtime message.new).' })
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
