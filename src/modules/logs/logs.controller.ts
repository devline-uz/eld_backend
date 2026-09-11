import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import {
  CertifyDto,
  CreateEditRequestDto,
  EditRequestListQueryDto,
  LogDateQueryDto,
  LogRangeQueryDto,
  ResolveEditRequestDto,
} from './dto/logs.dto';
import { LogsService } from './logs.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';

/**
 * TZ §9 / §11.4 — the "HOS Logs" Figma section: the daily log grid, the §395.30 edit flow and
 * certification.
 *
 * Route order matters: `edit-requests/:id/*` is declared BEFORE `:driverId/*` so a request id
 * is never swallowed by the driver-id parameter.
 */
@FigmaScreen('web/hos-logs')
@ApiTags('logs')
@ApiBearerAuth()
@Controller('logs')
export class LogsController {
  constructor(private readonly logs: LogsService) {}

  @Post('edit-requests/:id/accept')
  // §395.30(c)(1) — the DRIVER resolves a carrier proposal, nobody else. Without this guard
  // any authenticated principal (a permission-less back-office user, an unscoped API key)
  // could activate a carrier edit without the driver ever seeing it (bugs.md B-0NN).
  @UseGuards(DriverGuard)
  @ApiOperation({
    summary:
      'Driver accepts a carrier edit (§395.30): the proposal becomes the active record and the original is marked Inactive — Changed.',
  })
  @ApiCreatedResponse({
    description: 'The proposal is now the active record; the original keeps recordStatus = 2 (Inactive — Changed).',
    schema: {
      example: {
        id: 'edt_1',
        status: 'ACCEPTED',
        resolvedAt: '2026-09-11T15:41:00.000Z',
        activeEventId: 'evt_9001',
        supersededEventId: 'evt_8801',
        recertificationRequired: true,
      },
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Edit request not found.'),
      apiError.conflict(ERROR_CODES.EDIT_ALREADY_RESOLVED, 'This edit request was already accepted or rejected.'),
      apiError.unprocessable(ERROR_CODES.DRIVING_TIME_IMMUTABLE, 'Driving time can never be shortened, deleted or restatused (49 CFR §395.30).'),
    ],
  })
  accept(
    @Param('id') id: string,
    @Body(zodBody(ResolveEditRequestDto)) dto: ResolveEditRequestDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.logs.acceptEditRequest(id, actor, dto);
  }

  @Post('edit-requests/:id/reject')
  @UseGuards(DriverGuard)
  @ApiOperation({ summary: 'Driver rejects a carrier edit (§395.30): the request is closed, the log is unchanged.' })
  @ApiCreatedResponse({ description: 'The request is closed and the log is untouched.', schema: { example: { id: 'edt_1', status: 'REJECTED', resolvedAt: '2026-09-11T15:41:00.000Z', driverComment: 'I was off duty, not on duty.' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Edit request not found.'), apiError.conflict(ERROR_CODES.EDIT_ALREADY_RESOLVED, 'This edit request was already accepted or rejected.')] })
  reject(
    @Param('id') id: string,
    @Body(zodBody(ResolveEditRequestDto)) dto: ResolveEditRequestDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.logs.rejectEditRequest(id, actor, dto);
  }

  @Get(':driverId')
  @Perm('hos', 'READ')
  @ApiQuery({ name: 'date', required: false, description: 'RODS day (YYYY-MM-DD) in the driver\'s home terminal timezone.' })
  @ApiOperation({ summary: 'One RODS day: grid, records, violations and certification state (§9, §23).' })
  @ApiOkResponse({
    schema: {
      example: {
        driverId: 'drv_1',
        date: '2026-09-10',
        timezone: 'America/New_York',
        summary: { drivingSec: 32400, onDutySec: 7200, offDutySec: 39600, sleeperSec: 7200, certified: false },
        graph: [{ status: 'OFF', effective: 'OFF', startAt: '2026-09-10T04:00:00.000Z', durationSec: 3600 }],
      },
    },
  })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.')] })
  getDay(@Param('driverId') driverId: string, @Query(zodBody(LogDateQueryDto)) query: LogDateQueryDto) {
    return this.logs.getDay(driverId, query.date);
  }

  @Get(':driverId/range')
  @Perm('hos', 'READ')
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  @ApiOperation({ summary: 'Daily summaries for a range of RODS days (max 62).' })
  @ApiOkResponse({ schema: { example: { driverId: 'drv_1', from: '2026-09-03', to: '2026-09-10', days: [{ date: '2026-09-10', drivingSec: 32400, onDutySec: 7200, certified: false, violations: 2 }] } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.'), apiError.unprocessable(ERROR_CODES.RANGE_TOO_LARGE, 'The requested range exceeds 62 RODS days.')] })
  getRange(@Param('driverId') driverId: string, @Query(zodBody(LogRangeQueryDto)) query: LogRangeQueryDto) {
    return this.logs.getRange(driverId, query.from, query.to);
  }

  @Get(':driverId/events')
  @Perm('hos', 'READ')
  @ApiQuery({ name: 'date', required: false })
  @ApiOperation({
    summary:
      'Every §395 record of a RODS day, including superseded (2), proposed (3) and rejected (4) ones — the audit trail the inspector sees.',
  })
  @ApiOkResponse({ description: 'Append-only audit trail: active (1), superseded (2), proposed (3) and rejected (4) records.', schema: { example: { driverId: 'drv_1', date: '2026-09-10', events: [{ id: 'evt_8801', eventType: 1, eventCode: 3, eventSequenceId: 1042, recordStatus: 2, recordOrigin: 1, dutyStatus: 'ON', occurredAt: '2026-09-10T18:26:58.000Z', odometerMiles: 993590, latitude: 38.02, longitude: -84.5, locationDescription: '0.64 mi N of Florence, KY', checksumValid: true }] } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.')] })
  getEvents(@Param('driverId') driverId: string, @Query(zodBody(LogDateQueryDto)) query: LogDateQueryDto) {
    return this.logs.getEvents(driverId, query.date);
  }

  @Get(':driverId/edit-requests')
  @Perm('hos', 'READ')
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'ALL'] })
  @ApiOperation({ summary: 'Carrier edit proposals and how the driver answered them.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'edt_1', date: '2026-09-10', status: 'PENDING', requestedBy: 'usr_1', reason: 'Wrong duty status', createdAt: '2026-09-11T15:41:00.000Z' }] } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.')] })
  listEditRequests(
    @Param('driverId') driverId: string,
    @Query(zodBody(EditRequestListQueryDto)) query: EditRequestListQueryDto,
  ) {
    return this.logs.listEditRequests(driverId, query);
  }

  @Post(':driverId/edit-requests')
  @Perm('hosEdit', 'FULL')
  @ApiOperation({
    summary:
      'Proposes an edit to a driver record (§395.30). The proposal is INERT: it is stored with recordStatus = 3 and changes nothing until the driver accepts.',
  })
  @ApiCreatedResponse({
    description: 'Stored as an inert proposal (recordStatus = 3). Nothing in the log changes until the driver accepts.',
    schema: {
      example: {
        id: 'edt_9',
        driverId: 'drv_1',
        status: 'PENDING',
        date: '2026-09-10',
        reason: 'Driver forgot to switch to On duty while loading at shipper #4821.',
        proposed: { status: 'ON', startAt: '2026-09-10T18:26:58.000Z', endAt: '2026-09-10T19:30:00.000Z' },
        createdAt: '2026-09-11T15:41:00.000Z',
      },
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.'),
      apiError.unprocessable(ERROR_CODES.DRIVING_TIME_IMMUTABLE, 'Driving time can never be shortened, deleted or restatused (49 CFR §395.30).'),
    ],
  })
  createEditRequest(
    @Param('driverId') driverId: string,
    @Body(zodBody(CreateEditRequestDto)) dto: CreateEditRequestDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.logs.createEditRequest(driverId, dto, actor);
  }

  @Post(':driverId/certify')
  @ApiOperation({
    summary:
      'Certifies one or more RODS days (§9.2). A driver certifies their own log; a back-office user needs hosCertifyOnBehalf = FULL and the action is always audited.',
  })
  @ApiCreatedResponse({
    description: 'Certification is the driver signature; on-behalf certification is always written to the audit log.',
    schema: {
      example: {
        driverId: 'drv_1',
        certified: [
          { date: '2026-09-10', certifiedAt: '2026-09-11T15:41:00.000Z', certifiedBy: 'usr_1', onBehalf: true, signatureCount: 1 },
        ],
      },
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.forbidden('Certifying on behalf of a driver requires hosCertifyOnBehalf = FULL.'),
      apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.'),
      apiError.unprocessable(ERROR_CODES.RECERTIFICATION_REQUIRED, 'The log changed after the last certification — it must be certified again.'),
    ],
  })
  certify(
    @Param('driverId') driverId: string,
    @Body(zodBody(CertifyDto)) dto: CertifyDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.logs.certify({ ...dto, driverId }, actor);
  }
}
