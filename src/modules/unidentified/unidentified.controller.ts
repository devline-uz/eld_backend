import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
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
      'Driver answers "was this you?" (§7.4 rule 2). Accepting attributes the records with recordOrigin = 1 — never 2.',
  })
  @ApiCreatedResponse({ description: 'Accepting attributes the records to the driver with recordOrigin = 1 — never 2 (§23).', schema: { example: { id: 'seg_1', status: 'ASSIGNED', driverId: 'drv_1', recordOrigin: 1, eventCount: 4 } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Unidentified segment not found.'), apiError.conflict(ERROR_CODES.UNIDENTIFIED_ALREADY_ASSIGNED, 'This segment is already assigned to a driver.')] })
  confirm(
    @Param('id') id: string,
    @Body(zodBody(ConfirmUnidentifiedDto)) dto: ConfirmUnidentifiedDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.unidentified.confirm(id, dto, actor);
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
      'Assigns the segment to a driver: status ASSIGNED, assignedById/At set, recordOrigin stays 1, AuditLog entry UNIDENTIFIED_ASSIGNED.',
  })
  @ApiCreatedResponse({
    description: 'recordOrigin stays 1 forever (§23) and the assignment is audited as UNIDENTIFIED_ASSIGNED.',
    schema: {
      example: {
        id: 'seg_1',
        status: 'ASSIGNED',
        driverId: 'drv_1',
        assignedById: 'usr_1',
        assignedAt: '2026-09-11T15:41:00.000Z',
        recordOrigin: 1,
        eventCount: 4,
      },
    },
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
  @ApiCreatedResponse({ description: 'Annotation is capped at 60 characters (Appendix A).', schema: { example: { id: 'seg_1', status: 'ANNOTATED', annotation: 'Yard move by shop tech', annotatedById: 'usr_1' } } })
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
  @ApiCreatedResponse({ description: 'Records return to the pool with recordOrigin = 4 and driverId = null. Nothing is ever deleted (§23).', schema: { example: { id: 'seg_1', status: 'REJECTED', driverId: null, recordOrigin: 4, eventCount: 4 } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Unidentified segment not found.')] })
  reject(
    @Param('id') id: string,
    @Body(zodBody(RejectUnidentifiedDto)) dto: RejectUnidentifiedDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.unidentified.reject(id, dto, actor);
  }
}
