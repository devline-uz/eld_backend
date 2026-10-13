import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import {
  AnnotateUnidentifiedDto,
  AssignUnidentifiedDto,
  ConfirmUnidentifiedDto,
  RejectUnidentifiedDto,
  UnidentifiedListQueryDto,
} from './dto/unidentified.dto';
import { UnidentifiedService } from './unidentified.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import { UnidentifiedConfirmationRequestListResponse, UnidentifiedSegmentResponse } from './dto/unidentified.responses';

/** MB-12 — the `data` payload every write route returns (`UnidentifiedService.toView`). */
const SEGMENT_EXAMPLE = {
  id: '6f1c2a0e-3d1b-4c55-9a51-2f0f6b1d9e10',
  vehicleId: 'b3e0c1d2-8a4f-4f0e-9d7c-1a2b3c4d5e6f',
  startAt: '2026-09-10T12:30:00.000Z',
  endAt: '2026-09-10T13:00:00.000Z',
  durationSec: 1800,
  distanceMi: 21,
  status: 'ASSIGNED',
  assignedDriverId: 'drv_1',
  assignedById: 'usr_1',
  assignedAt: '2026-09-11T15:41:00.000Z',
  annotation: 'Unidentified driving assigned to johnsmith',
  confirmationRequestedAt: null,
  fromStoredEvents: true,
  eventIds: ['7701', '7702'],
};

/**
 * TZ §5.9 / §7.4 / §11.4 — the "Unidentified driving" Figma screen plus the driver-side
 * "was this you?" confirmation.
 */
@FigmaScreen('web/hos-logs', 'web/fleet-dashboard')
@ApiTags('unidentified')
@ApiBearerAuth()
@Controller('unidentified')
export class UnidentifiedController {
  constructor(private readonly unidentified: UnidentifiedService) {}

  @Post(':id/confirm')
  @UseGuards(DriverGuard)
  @ApiOperation({
    summary:
      'Driver answers "was this you?" (§7.4 rule 2). Accepting = the driver assumes the records: recordOrigin = 4 (Appendix A 4.4.4.2.4(e), MB-3) — never 2.',
    description:
      'Body `{accept: boolean, annotation?: string (4-60)}`. On a `PENDING_CONFIRMATION` segment only the asked driver may answer: ' +
      'accept → `ASSIGNED` (assignedById stays the carrier user who asked), decline → back to `PENDING`, nothing written. ' +
      'On any other segment, accept is a self-claim and needs a driver↔unit association (§395.32, else 403). ' +
      'Response `data` is the segment after the answer.',
  })
  @ApiEnvelopeResponse(UnidentifiedSegmentResponse, {
    status: 201,
    description: 'The segment after the answer. Attributed copies carry recordOrigin = 4 and recordStatus = 1; the pool originals are retired (recordStatus 2), never deleted (§23).',
    example: SEGMENT_EXAMPLE,
  })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Unidentified segment not found.'), apiError.forbidden('This unidentified driving is awaiting confirmation from another driver, or the driver never operated this unit (§395.32).'), apiError.conflict(ERROR_CODES.UNIDENTIFIED_ALREADY_ASSIGNED, 'This segment is already assigned to a driver.')] })
  confirm(
    @Param('id') id: string,
    @Body(zodBody(ConfirmUnidentifiedDto)) dto: ConfirmUnidentifiedDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.unidentified.confirm(id, dto, actor);
  }

  @Get('confirmation-requests')
  @UseGuards(DriverGuard)
  @ApiOperation({
    summary:
      'B-83 — driver app: segments a carrier asked THIS driver to confirm (status PENDING_CONFIRMATION). Answer with POST /unidentified/:id/confirm.',
  })
  @ApiEnvelopeResponse(UnidentifiedConfirmationRequestListResponse, {
    description: 'MB-11 — every item adds `startLocation`/`endLocation` (Appendix A 7.29 text), `unitNumber`, `startOdometerMi`/`endOdometerMi` to the segment fields. Up to 200 items, newest first.',
    example: {
      items: [
        {
          ...SEGMENT_EXAMPLE,
          status: 'PENDING_CONFIRMATION',
          assignedAt: null,
          annotation: null,
          confirmationRequestedAt: '2026-09-11T15:41:00.000Z',
          startLocation: '3mi W OH Columbus',
          endLocation: '1mi N OH Hilliard',
          unitNumber: '4821',
          startOdometerMi: 120345,
          endOdometerMi: 120366,
        },
      ],
    },
  })
  @ApiStandardErrors()
  listConfirmationRequests(@CurrentUser() actor: ContextUser) {
    return this.unidentified.listConfirmationRequests(actor);
  }

  @Get()
  @Perm('hos', 'READ')
  @ApiOperation({ summary: 'Lists unidentified driving segments (§5.9).' })
  @ApiOkResponse({
    schema: {
      example: {
        items: [
          {
            id: 'seg_1',
            vehicleId: 'veh_1',
            durationSec: 1800,
            distanceMi: 21,
            status: 'PENDING',
            fromStoredEvents: true,
          },
        ],
        total: 1,
        page: 1,
      },
    },
  })
  @ApiStandardErrors()
  list(@Query(zodBody(UnidentifiedListQueryDto)) query: UnidentifiedListQueryDto) {
    return this.unidentified.list(query);
  }

  @Get(':id')
  @Perm('hos', 'READ')
  @ApiOperation({ summary: 'One segment with the §395 records behind it (never deleted, §23).' })
  @ApiOkResponse({ schema: { example: { id: 'seg_1', vehicleId: 'veh_1', status: 'PENDING', durationSec: 1800, distanceMi: 21, fromStoredEvents: true, events: [{ id: 'evt_7701', eventSequenceId: 981, recordOrigin: 1, dutyStatus: 'D', occurredAt: '2026-09-10T12:30:00.000Z', odometerMiles: 993218 }] } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Unidentified segment not found.')] })
  get(@Param('id') id: string) {
    return this.unidentified.get(id);
  }

  @Post(':id/assign')
  @Perm('hosEdit', 'FULL')
  @ApiOperation({
    summary:
      'Assigns the segment to a driver: status ASSIGNED, assignedById/At set, recordOrigin stays 1, AuditLog entry UNIDENTIFIED_ASSIGNED. With requireDriverConfirmation = true (B-83) nothing is attributed yet: status PENDING_CONFIRMATION, the driver is asked in the app (AuditLog UNIDENTIFIED_CONFIRMATION_REQUESTED) and the records move to their log only when they confirm.',
  })
  @ApiEnvelopeResponse(UnidentifiedSegmentResponse, {
    status: 201,
    description: 'The segment after the assignment. A carrier assignment keeps recordOrigin 1 (TZ §23) and is audited as UNIDENTIFIED_ASSIGNED.',
    example: SEGMENT_EXAMPLE,
  })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Unidentified segment not found.'),
      apiError.conflict(ERROR_CODES.UNIDENTIFIED_ALREADY_ASSIGNED, 'This segment is already assigned to a driver.'),
    ],
  })
  assign(
    @Param('id') id: string,
    @Body(zodBody(AssignUnidentifiedDto)) dto: AssignUnidentifiedDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.unidentified.assign(id, dto, actor);
  }

  @Post(':id/annotate')
  @Perm('hosEdit', 'FULL')
  @ApiOperation({ summary: 'Annotates the segment (max 60 chars, Appendix A).' })
  @ApiEnvelopeResponse(UnidentifiedSegmentResponse, {
    status: 201,
    description: 'Annotation is capped at 60 characters (Appendix A). A PENDING segment becomes ANNOTATED.',
    example: { ...SEGMENT_EXAMPLE, status: 'ANNOTATED', assignedDriverId: null, assignedById: null, assignedAt: null, annotation: 'Yard move by shop tech' },
  })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Unidentified segment not found.')] })
  annotate(
    @Param('id') id: string,
    @Body(zodBody(AnnotateUnidentifiedDto)) dto: AnnotateUnidentifiedDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.unidentified.annotate(id, dto, actor);
  }

  @Post(':id/reject')
  @Perm('hosEdit', 'FULL')
  @ApiOperation({
    summary:
      'Rejects the assignment: the records go back to the pool with recordOrigin = 4 and driverId = null. Nothing is deleted.',
  })
  @ApiEnvelopeResponse(UnidentifiedSegmentResponse, {
    status: 201,
    description: 'Records return to the pool with recordOrigin = 4 and driverId = null. Nothing is ever deleted (§23).',
    example: { ...SEGMENT_EXAMPLE, status: 'REJECTED', assignedDriverId: null, annotation: 'Not this driver' },
  })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Unidentified segment not found.')] })
  reject(
    @Param('id') id: string,
    @Body(zodBody(RejectUnidentifiedDto)) dto: RejectUnidentifiedDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.unidentified.reject(id, dto, actor);
  }
}
