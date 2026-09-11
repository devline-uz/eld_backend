import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import {
  CertifyDto,
  CreateLogEntryDto,
  EditRequestListQueryDto,
  LogDateQueryDto,
} from './dto/logs.dto';
import { LogsService } from './logs.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';

/**
 * TZ §9.3 / §11.8 — the driver-side RODS endpoints. Driver JWT only (§6.1): a back-office
 * token must never post a record as if the driver had entered it.
 *
 * Figma: "Driver app → Logs → Add entry" and "Driver app → Logs → Certify".
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile')
export class MobileLogsController {
  constructor(private readonly logs: LogsService) {}

  @Post('log-entries')
  @ApiOperation({
    summary:
      "Driver's own log correction (§9.3): recordOrigin = 2, recordStatus = 1, active immediately. Annotation 4-60 chars is mandatory and certification is invalidated.",
  })
  @ApiCreatedResponse({
    description: 'recordOrigin = 2 (driver), recordStatus = 1 (active immediately); certification is invalidated.',
    schema: {
      example: {
        id: 'evt_9100',
        eventSequenceId: 1043,
        recordOrigin: 2,
        recordStatus: 1,
        dutyStatus: 'ON',
        occurredAt: '2026-09-10T18:26:58.000Z',
        annotation: 'Loading at shipper #4821',
        recertificationRequired: true,
      },
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.unprocessable(
        ERROR_CODES.DRIVING_TIME_IMMUTABLE,
        'The driver may move between OFF/SB/ON but can never shorten, delete, restatus or hand-enter driving time (49 CFR §395.30).',
      ),
    ],
  })
  createEntry(@Body(zodBody(CreateLogEntryDto)) dto: CreateLogEntryDto, @CurrentUser() actor: ContextUser) {
    return this.logs.createLogEntry(actor.id, dto, actor);
  }

  @Post('certify')
  @ApiOperation({ summary: 'Certifies RODS days from the driver app; queued offline and replayed on sync (§13.2).' })
  @ApiCreatedResponse({ schema: { example: { driverId: 'drv_1', certified: [{ date: '2026-09-10', certifiedAt: '2026-09-11T15:41:00.000Z', signatureCount: 1 }] } } })
  @ApiStandardErrors({ errors: [apiError.unprocessable(ERROR_CODES.RECERTIFICATION_REQUIRED, 'The log changed after the last certification — it must be certified again.')] })
  certify(@Body(zodBody(CertifyDto)) dto: CertifyDto, @CurrentUser() actor: ContextUser) {
    return this.logs.certify({ ...dto, driverId: undefined }, actor);
  }

  @Get('log-edit-requests')
  @ApiOperation({ summary: 'Carrier edit proposals waiting for this driver (§395.30 — nothing applies until they answer).' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'edt_1', date: '2026-09-10', status: 'PENDING', reason: 'Driver forgot to switch to On duty while loading at shipper #4821.', proposed: { status: 'ON', startAt: '2026-09-10T18:26:58.000Z', endAt: '2026-09-10T19:30:00.000Z' } }] } } })
  @ApiStandardErrors()
  listEditRequests(
    @Query(zodBody(EditRequestListQueryDto)) query: EditRequestListQueryDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.logs.listEditRequests(actor.id, query);
  }

  @Get('logs')
  @ApiOperation({ summary: "The driver's own RODS day (grid, records, certification state)." })
  @ApiOkResponse({ schema: { example: { driverId: 'drv_1', date: '2026-09-10', timezone: 'America/New_York', summary: { drivingSec: 32400, onDutySec: 7200, offDutySec: 39600, sleeperSec: 7200, certified: false }, graph: [{ status: 'OFF', effective: 'OFF', startAt: '2026-09-10T04:00:00.000Z', durationSec: 3600 }] } } })
  @ApiStandardErrors()
  getDay(@Query(zodBody(LogDateQueryDto)) query: LogDateQueryDto, @CurrentUser() actor: ContextUser) {
    return this.logs.getDay(actor.id, query.date);
  }
}
