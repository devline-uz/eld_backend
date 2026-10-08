import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import type { ContextUser } from '../../core/context/request-context';
import {
  CertificationStatusQueryDto,
  CertifyDto,
  CreateLogEntryDto,
  EditRequestListQueryDto,
  LogDateQueryDto,
} from './dto/logs.dto';
import {
  CertificationStatusDayResponse,
  CertifyResponse,
  EditRequestListResponse,
  LogDayResponse,
  LogEntryResultResponse,
} from './dto/logs.responses';
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
  @ApiEnvelopeResponse(LogEntryResultResponse, {
    status: 201,
    description: 'recordOrigin = 2 (driver), recordStatus = 1 (active immediately); certification is invalidated.',
    example: {
      id: '9100',
      driverId: 'drv_1',
      status: 'ON',
      specialCondition: 'NONE',
      locationName: 'Columbus, OH',
      startAt: '2026-09-10T18:26:58.000Z',
      endAt: null,
      recordOrigin: 2,
      recordStatus: 1,
      applied: true,
      recertificationRequired: true,
    },
  })
  @ApiStandardErrors({
    errors: [
      {
        ...apiError.unprocessable(
          ERROR_CODES.DRIVING_TIME_IMMUTABLE,
          'The driver may move between OFF/SB/ON but can never shorten, delete, restatus or hand-enter driving time (49 CFR §395.30).',
        ),
        description:
          '422 — one of: DRIVING_TIME_IMMUTABLE (driving time can never be shortened/restatused/hand-entered); ' +
          'SPECIAL_CONDITION_NOT_ALLOWED (MR-23: `specialCondition` PC/YM while the driver exception is off, ' +
          'details.exception = allowPersonalConveyance | allowYardMove); VALIDATION_FAILED (PC needs OFF, YM needs ON, ' +
          '`locationName` 5-60 chars per §395 Appendix A).',
      },
    ],
  })
  createEntry(@Body(zodBody(CreateLogEntryDto)) dto: CreateLogEntryDto, @CurrentUser() actor: ContextUser) {
    return this.logs.createLogEntry(actor.id, dto, actor);
  }

  @Post('certify')
  @ApiOperation({
    summary: 'Certifies RODS days from the driver app; queued offline and replayed on sync (§13.2).',
    description:
      'MR-5 — idempotent on `clientId` (UUID): a replay with the same `clientId` returns the FIRST response and ' +
      'appends no second certification record, so `certificationCount` does not move. The same key space is shared ' +
      'with `/mobile/sync` `certify` changes.\n\n' +
      'Re-certification: certifying a day that is already certified, or one whose certification was voided by a ' +
      'later change (`recertificationRequired: true` in `GET /mobile/logs` / `GET /mobile/certification-status`), ' +
      'is always accepted and appends a new eventType 4 record (event code 2..9). This endpoint therefore never ' +
      'returns `422 RECERTIFICATION_REQUIRED` — that code is a state, read from `recertificationRequired`. ' +
      '422 `VALIDATION_FAILED` is returned for a future date.',
  })
  @ApiEnvelopeResponse(CertifyResponse, {
    status: 201,
    example: {
      driverId: 'drv_1',
      days: [{ date: '2026-09-10', certified: true, certificationCount: 1, eventCode: 1, certifiedAt: '2026-09-11T15:41:00.000Z', certifierType: 'DRIVER' }],
    },
  })
  @ApiStandardErrors()
  certify(@Body(zodBody(CertifyDto)) dto: CertifyDto, @CurrentUser() actor: ContextUser) {
    return this.logs.certify({ ...dto, driverId: undefined }, actor);
  }

  @Get('log-edit-requests')
  @ApiOperation({ summary: 'Carrier edit proposals waiting for this driver (§395.30 — nothing applies until they answer).' })
  @ApiEnvelopeResponse(EditRequestListResponse, {
    example: {
      driverId: 'drv_1',
      items: [
        {
          id: '9120', driverId: 'drv_1', status: 'PENDING', kind: 'EDIT', originalEventId: '9100', proposedStatus: 'ON', proposedSpecial: 'NONE',
          proposedStart: '2026-09-10T18:26:58.000Z', proposedEnd: '2026-09-10T19:30:00.000Z', locationName: 'Columbus, OH',
          annotation: 'Forgot to switch to On duty while loading', requestedById: 'usr_1', requestedAt: '2026-09-11T14:00:00.000Z', resolvedAt: null,
        },
      ],
    },
  })
  @ApiStandardErrors()
  listEditRequests(
    @Query(zodBody(EditRequestListQueryDto)) query: EditRequestListQueryDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.logs.listEditRequests(actor.id, query);
  }

  @Get('certification-status')
  @ApiQuery({ name: 'days', required: false, schema: { type: 'integer', minimum: 1, maximum: 14, default: 8 }, description: 'How many RODS days, today included (1-14, default 8 = the §395 8-day inspection window).' })
  @ApiOperation({
    summary: 'MR-26 — certification state of the last `days` RODS days (default 8, max 14), today included, oldest first.',
    description:
      '`recertificationRequired` is true only for a day that WAS certified and changed afterwards ' +
      '(`certified=false && certificationCount>0`). A day with no records yet is `certified:false`.',
  })
  @ApiEnvelopeResponse(CertificationStatusDayResponse, {
    isArray: true,
    example: [
      { date: '2026-10-07', certified: true, certifiedAt: '2026-10-08T01:02:00.000Z', certificationCount: 1, recertificationRequired: false },
      { date: '2026-10-08', certified: false, certifiedAt: null, certificationCount: 1, recertificationRequired: true },
    ],
  })
  @ApiStandardErrors()
  certificationStatus(
    @Query(zodBody(CertificationStatusQueryDto)) query: CertificationStatusQueryDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.logs.getCertificationStatus(actor.id, query.days);
  }

  @Get('logs')
  @ApiQuery({ name: 'date', required: false, schema: { type: 'string', format: 'date', example: '2026-09-10' }, description: 'RODS day (home-terminal zone); default today.' })
  @ApiOperation({
    summary: "The driver's own RODS day (grid, records, certification state).",
    description:
      'Additive fields (2026-10-08): `trip` {shippingDocuments, trailerNumbers, notes, bobtail, tripIds, tripNumbers} ' +
      'from the trips overlapping the day (MR-12), merged (D-129) with the driver\'s no-trip day details for that day ' +
      '(union of lists, trip notes win; `dayDetails: true` when a day-details row exists — written by `PATCH /mobile/trip` with no active trip); `malfunctionIndicator` / `diagnosticIndicator` — an Appendix A ' +
      'malfunction / data diagnostic was in force at some instant of the day (MR-16); every `graph` segment carries ' +
      '`eventId`, `locationDescription`, `odometerMi`, `engineHours`, `annotation`, `carriedOver` of the record that ' +
      'opened it, and every event `eventId`, `locationDescription`, `odometerMi`, `engineHours`, `specialCondition` (MR-13). ' +
      '`locationDescription` is the stored location text (device-provided or driver-entered); when there is none, the server computes the §395 Appendix A 7.29 geo-location offline from the stored position (`3mi W OH Columbus`, PC: 10-mile steps — `docs/location-description.md`).',
  })
  @ApiEnvelopeResponse(LogDayResponse, {
    example: {
      driverId: 'drv_1',
      date: '2026-09-10',
      timezone: 'America/New_York',
      summary: {
        date: '2026-09-10', timezone: 'America/New_York', offDutySec: 39600, sleeperSec: 7200, drivingSec: 32400, onDutySec: 7200, totalDistanceMi: 512,
        dayLengthSec: 86400, certified: false, certifiedAt: null, certificationCount: 0, hasViolation: false, violationCount: 0, hasUnassigned: false, hasEdits: false,
      },
      graph: [{ status: 'OFF', effective: 'OFF', special: 'NONE', startAt: '2026-09-10T04:00:00.000Z', endAt: '2026-09-10T05:00:00.000Z', durationSec: 3600, eventId: '9100', locationDescription: '3mi W OH Columbus', odometerMi: 120345, engineHours: 5321.4, annotation: null, carriedOver: true }],
      events: [
        {
          id: '9101', eventType: 1, eventCode: 3, eventSequenceId: 1043, eventDateTime: '2026-09-10T05:00:00.000Z', recordStatus: 1, recordOrigin: 1, status: 'D',
          locationName: null, totalVehicleMiles: 120345, totalEngineHours: 5321.4, annotation: null, comment: null, supersedesId: null, editedById: null, editorType: null, editReason: null,
          vehicleId: 'veh_1', eventId: '9101', locationDescription: '3mi W OH Columbus', odometerMi: 120345, engineHours: 5321.4, specialCondition: null, malfunctionCode: null, diagnosticCode: null,
        },
      ],
      trip: { shippingDocuments: ['BOL-4821'], trailerNumbers: ['TR-778'], notes: null, bobtail: false, tripIds: ['5b0c…'], tripNumbers: ['T-1042'], dayDetails: false },
      malfunctionIndicator: false,
      diagnosticIndicator: false,
      violations: [],
      certification: { certified: false, certifiedAt: null, certifiedById: null, certifierType: null, certificationCount: 0, signatureUrl: null, recertificationRequired: false },
    },
  })
  @ApiStandardErrors()
  getDay(@Query(zodBody(LogDateQueryDto)) query: LogDateQueryDto, @CurrentUser() actor: ContextUser) {
    return this.logs.getDay(actor.id, query.date);
  }
}
