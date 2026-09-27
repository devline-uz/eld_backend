import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiStandardErrors } from '../../common/errors';
import type { ContextUser } from '../../core/context/request-context';
import { CreateFeedbackDto, CreateSupportTicketDto } from './dto/support.dto';
import { RequesterContext, SupportService } from './support.service';
import { SupportRepository } from './support.repository';

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
  @ApiCreatedResponse({ schema: { example: { id: 'fbk_1', comment: 'Great app!', createdAt: '2026-09-21T00:00:00.000Z' } } })
  @ApiStandardErrors()
  createFeedback(@Body(zodBody(CreateFeedbackDto)) dto: CreateFeedbackDto, @CurrentUser() actor: ContextUser) {
    const requester: RequesterContext = { id: actor.id, type: 'driver' };
    return this.support.createFeedback(dto, requester);
  }

  @Post('support/tickets')
  @Audit({ object: 'SupportTicket', action: 'CREATE' })
  @ApiOperation({ summary: 'M-30/M-22 — opens a support ticket from the driver app (also used by "Send diagnostics to support", category: diagnostics).' })
  @ApiCreatedResponse({ schema: { example: { id: 'tck_9', number: 'TCK-000009', subject: 'App crashes on certify', status: 'OPEN', priority: 'NORMAL' } } })
  @ApiStandardErrors()
  createTicket(@Body(zodBody(CreateSupportTicketDto)) dto: CreateSupportTicketDto, @CurrentUser() actor: ContextUser) {
    const requester: RequesterContext = { id: actor.id, type: 'driver' };
    return this.support.create(dto, requester);
  }

  @Get('support/tickets')
  @ApiOperation({ summary: 'M-30/M-22 — lists the calling driver\'s own support tickets.' })
  @ApiOkResponse({
    schema: {
      example: {
        items: [
          {
            id: 'tck_1',
            subject: 'App crashes on certify',
            category: 'diagnostics',
            priority: 'NORMAL',
            status: 'OPEN',
            createdAt: '2026-09-21T00:00:00.000Z',
            updatedAt: '2026-09-21T00:00:00.000Z',
          },
        ],
      },
    },
  })
  @ApiStandardErrors()
  async listOwnTickets(@CurrentUser('id') driverId: string) {
    const items = await this.repo.findMany({ createdByDriverId: driverId }, undefined, { createdAt: 'desc' });
    return {
      items: items.map((t) => ({
        id: t.id,
        subject: t.subject,
        category: t.category,
        priority: t.priority,
        status: t.status,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    };
  }
}
