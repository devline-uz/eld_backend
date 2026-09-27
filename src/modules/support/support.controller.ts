import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CreateFeedbackDto, CreateSupportChatDto, CreateSupportTicketDto, SupportTicketListQueryDto, UpdateSupportTicketDto } from './dto/support.dto';
import { RequesterContext, SupportService } from './support.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';

/** TZ §5.10, §11.7 `/support/tickets`, `/feedback` — "Settings > Support" Figma screen. Gated by `support`. */
@FigmaScreen('web/settings-support')
@ApiTags('support')
@ApiBearerAuth()
@Controller()
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get('support/tickets')
  @Perm('support', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sort', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiOperation({ summary: 'Lists support tickets.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'tck_1', number: 'TCK-000001', subject: 'Device offline', status: 'OPEN' }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  list(@Query(zodBody(SupportTicketListQueryDto)) query: SupportTicketListQueryDto) {
    return this.support.list(query);
  }

  @Get('support/tickets/:id')
  @Perm('support', 'READ')
  @ApiOperation({ summary: 'Gets one support ticket.' })
  @ApiOkResponse({ schema: { example: { id: 'tck_1', number: 'TCK-000001', subject: 'Device offline', body: 'Unit #110 has not reported since Sep 09.', status: 'OPEN', priority: 'HIGH', requesterType: 'USER', requesterId: 'usr_1', createdAt: '2026-09-11T15:41:00.000Z' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Support ticket not found.')] })
  get(@Param('id') id: string) {
    return this.support.get(id);
  }

  @Post('support/tickets')
  @Perm('support', 'READ')
  @Audit({ object: 'SupportTicket', action: 'CREATE' })
  @ApiOperation({ summary: "Opens a support ticket. B-12: allowed at support:READ (e.g. VIEWER) — submitting a ticket isn't a config change." })
  @ApiCreatedResponse({ schema: { example: { id: 'tck_9', number: 'TCK-000009', subject: 'eRODS transfer rejected', status: 'OPEN', priority: 'NORMAL' } } })
  @ApiStandardErrors()
  create(@Body(zodBody(CreateSupportTicketDto)) dto: CreateSupportTicketDto, @CurrentUser() requester: RequesterContext) {
    return this.support.create(dto, requester);
  }

  @Patch('support/tickets/:id')
  @Perm('support', 'FULL')
  @Audit({ object: 'SupportTicket', action: 'UPDATE' })
  @ApiOperation({ summary: 'Updates a support ticket (status, priority, assignee).' })
  @ApiOkResponse({ schema: { example: { id: 'tck_1', number: 'TCK-000001', status: 'RESOLVED', priority: 'HIGH', assigneeId: 'usr_2' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Support ticket not found.')] })
  update(@Param('id') id: string, @Body(zodBody(UpdateSupportTicketDto)) dto: UpdateSupportTicketDto) {
    return this.support.update(id, dto);
  }

  @Post('support/chats')
  @Perm('support', 'READ')
  @Audit({ object: 'Conversation', action: 'CREATE' })
  @ApiOperation({ summary: 'B-90 — opens a real-time support chat (Conversation type SUPPORT) and sends the first message; subscribe the `conversation:{id}` socket room for replies.' })
  @ApiCreatedResponse({ schema: { example: { conversationId: 'cnv_9', messageId: 'msg_1' } } })
  @ApiStandardErrors()
  createChat(@Body(zodBody(CreateSupportChatDto)) dto: CreateSupportChatDto, @CurrentUser() requester: RequesterContext) {
    return this.support.createChat(dto, requester);
  }

  @Post('feedback')
  @Perm('support', 'READ')
  @Audit({ object: 'Feedback', action: 'CREATE' })
  @ApiOperation({ summary: "Submits in-app feedback (mobile + web). B-12: allowed at support:READ." })
  @ApiCreatedResponse({ schema: { example: { id: 'fbk_1', rating: 5, message: 'The 8-day recap view is exactly what we needed.', source: 'WEB', createdAt: '2026-09-11T15:41:00.000Z' } } })
  @ApiStandardErrors()
  createFeedback(@Body(zodBody(CreateFeedbackDto)) dto: CreateFeedbackDto, @CurrentUser() requester: RequesterContext) {
    return this.support.createFeedback(dto, requester);
  }
}
