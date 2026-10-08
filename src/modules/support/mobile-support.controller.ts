import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import type { ContextUser } from '../../core/context/request-context';
import { CreateFeedbackDto, MobileCreateSupportTicketDto } from './dto/support.dto';
import {
  FeedbackResponse,
  MobileSupportTicketCreatedResponse,
  MobileSupportTicketListResponse,
  MobileSupportTicketView,
} from './dto/mobile-support.responses';
import type { SupportTicket } from '@prisma/client';
import { SupportService } from './support.service';
import { SupportRepository } from './support.repository';

/** MR-20 — the driver-facing ticket row (`contactMethod` is the stored `SupportTicket.contactMethod`). */
function toMobileTicket(t: SupportTicket) {
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    body: t.body,
    category: t.category,
    priority: t.priority,
    status: t.status,
    contactMethod: t.contactMethod ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/**
 * mobile/tz.md §21, §4.4, §10.2 — screens M-23/P-10 (feedback), M-30/M-22 (support
 * tickets, incl. "Send diagnostics to support" from M-20 with `category: 'diagnostics'`).
 * Thin wrapper over the existing `SupportService`/`SupportRepository` per MD-001: new
 * routes under `mobile`, driver-only, existing web `/support/tickets` untouched.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile')
export class MobileSupportController {
  constructor(
    private readonly support: SupportService,
    private readonly repo: SupportRepository,
  ) {}

  @Post('feedback')
  @Audit({ object: 'Feedback', action: 'CREATE' })
  @ApiOperation({ summary: 'M-23/P-10 — submits in-app feedback from the driver app.' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['answers'],
      properties: {
        answers: {
          type: 'object',
          description: 'MR-28 — the 4-question survey (M-22): the selected chip value (string) or score (number) per question. Extra keys are accepted and stored.',
          properties: {
            tenure: { oneOf: [{ type: 'string' }, { type: 'number' }], example: '1-3 years' },
            ease: { oneOf: [{ type: 'string' }, { type: 'number' }], example: 'Easy' },
            hosSatisfaction: { oneOf: [{ type: 'string' }, { type: 'number' }], example: 'Satisfied' },
            recommend: { oneOf: [{ type: 'string' }, { type: 'number' }], example: 9 },
          },
          additionalProperties: true,
        },
        comment: { type: 'string', maxLength: 1000 },
        appVersion: { type: 'string', maxLength: 40 },
        platform: { type: 'string', maxLength: 40 },
        clientId: { type: 'string', format: 'uuid', description: 'MR-20 — idempotency key; a replay returns the first row.' },
      },
    },
  })
  @ApiEnvelopeResponse(FeedbackResponse, {
    status: 201,
    example: { id: 'fbk_1', driverId: 'drv_1', userId: null, answers: { tenure: '1-3 years', ease: 'Easy', hosSatisfaction: 'Satisfied', recommend: 9, overallExperience: 5 }, comment: 'Great app!', appVersion: '1.0.3', platform: 'android', createdAt: '2026-09-21T00:00:00.000Z' },
  })
  @ApiStandardErrors()
  createFeedback(@Body(zodBody(CreateFeedbackDto)) dto: CreateFeedbackDto, @CurrentUser() actor: ContextUser) {
    return this.support.createFeedbackForDriver(dto, actor.id);
  }

  @Post('support/tickets')
  @Audit({ object: 'SupportTicket', action: 'CREATE' })
  @ApiOperation({ summary: 'M-30/M-22 — opens a support ticket from the driver app (also used by "Send diagnostics to support", category: diagnostics). MR-20: optional `contactMethod` (EMAIL|PHONE) and idempotent `clientId`.', description: '`contactMethod` (EMAIL | PHONE, optional, null = not said) is stored on the ticket and returned by `GET /mobile/support/tickets` and `GET /mobile/support/tickets/{id}`. A replay with the same `clientId` returns the first ticket unchanged.' })
  @ApiEnvelopeResponse(MobileSupportTicketCreatedResponse, {
    status: 201,
    example: { id: 'tck_9', number: 'TCK-000009', subject: 'App crashes on certify', body: 'It closes after tapping Certify.', category: 'diagnostics', priority: 'NORMAL', status: 'OPEN', createdByUserId: null, createdByDriverId: 'drv_1', assignedToId: null, contactMethod: 'PHONE', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', resolvedAt: null },
  })
  @ApiStandardErrors()
  createTicket(@Body(zodBody(MobileCreateSupportTicketDto)) dto: MobileCreateSupportTicketDto, @CurrentUser() actor: ContextUser) {
    return this.support.createForDriver(dto, actor.id);
  }

  @Get('support/tickets/:id')
  @ApiOperation({ summary: 'MR-20 — one of the calling driver\'s own support tickets (404 for any other id).' })
  @ApiEnvelopeResponse(MobileSupportTicketView, { example: { id: 'tck_9', number: 'TCK-000009', subject: 'App crashes on certify', body: 'It closes after tapping Certify.', category: 'diagnostics', priority: 'NORMAL', status: 'OPEN', contactMethod: null, createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z' } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Support ticket not found.')] })
  async getOwnTicket(@Param('id') id: string, @CurrentUser('id') driverId: string) {
    return toMobileTicket(await this.support.getForDriver(id, driverId));
  }

  @Get('support/tickets')
  @ApiOperation({ summary: 'M-30/M-22 — lists the calling driver\'s own support tickets.' })
  @ApiEnvelopeResponse(MobileSupportTicketListResponse, {
    example: {
      items: [
        { id: 'tck_1', number: 'TCK-000001', subject: 'App crashes on certify', body: 'It closes after tapping Certify.', category: 'diagnostics', priority: 'NORMAL', status: 'OPEN', contactMethod: null, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' },
      ],
    },
  })
  @ApiStandardErrors()
  async listOwnTickets(@CurrentUser('id') driverId: string) {
    const items = await this.repo.findMany({ createdByDriverId: driverId }, undefined, { createdAt: 'desc' });
    return {
      items: items.map((t) => toMobileTicket(t)),
    };
  }
}
