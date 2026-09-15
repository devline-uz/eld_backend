import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { ResolveViolationDto, ViolationListQueryDto } from './dto/violations.dto';
import { ViolationsService } from './violations.service';

/** B-6 (web/tz.md §20, tz.md §11.4) — W-01 violations panel and W-08 `Resolve`. */
@FigmaScreen('web/fleet-dashboard', 'web/hos-logs')
@ApiTags('violations')
@ApiBearerAuth()
@Controller('violations')
export class ViolationsController {
  constructor(private readonly violations: ViolationsService) {}

  @Get()
  @Perm('hos', 'READ')
  @ApiOperation({ summary: 'Fleet HOS violation list (default status=OPEN) with driver name and unit.' })
  @ApiOkResponse({
    schema: {
      example: {
        items: [
          {
            id: 'vio_1', driverId: 'drv_1', dailyLogId: 'dl_1', logDate: '2026-09-14', type: 'DRIVING_11',
            occurredAt: '2026-09-14T14:26:00.000Z', exceededBySec: 1560, detail: 'Driving 11h26m', status: 'OPEN',
            resolvedAt: null, resolvedById: null, resolutionNote: null, severity: 'VIOLATION', driverName: 'John Smith',
            vehicleId: 'veh_1', unitNumber: '101', event: '11-hour driving limit exceeded',
            locationLabel: '1.04 mi W of Harrisburg, OH', date: '2026-09-14',
          },
        ],
        total: 1, page: 1, limit: 25, totalPages: 1,
      },
    },
  })
  @ApiStandardErrors()
  list(@Query(zodBody(ViolationListQueryDto)) query: ViolationListQueryDto) {
    return this.violations.list(query);
  }

  @Post(':id/resolve')
  @Perm('hosEdit', 'FULL')
  @ApiOperation({
    summary: 'Resolves an OPEN violation with a 4-60 char note. Audited as VIOLATION_RESOLVED; RODS records are never changed.',
  })
  @ApiCreatedResponse({ schema: { example: { id: 'vio_1', status: 'RESOLVED', resolvedAt: '2026-09-14T15:41:00.000Z', resolutionNote: 'Adverse weather, dispatcher confirmed' } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Violation not found.'),
      apiError.conflict(ERROR_CODES.CONFLICT, 'Only an OPEN violation can be resolved.'),
    ],
  })
  resolve(
    @Param('id') id: string,
    @Body(zodBody(ResolveViolationDto)) dto: ResolveViolationDto,
    @CurrentUser() actor: ContextUser,
  ) {
    return this.violations.resolve(id, dto, actor);
  }
}
