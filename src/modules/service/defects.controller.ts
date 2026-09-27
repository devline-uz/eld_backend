import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { DefectsService } from './defects.service';
import { AssignDefectDto, DefectListQueryDto, LinkDefectWorkOrderDto, ResolveDefectDto } from './dto/service.dto';

/** TZ §5.10 — defect reporting complement to `POST /mobile/dvir` (driver submission): list,
 * inspect and resolve defects raised by a DVIR. Resolving the last OPEN CRITICAL defect on a
 * unit restores `Vehicle.status` from `OUT_OF_SERVICE` automatically (see DefectsService). */
@FigmaScreen('web/dvir-maintenance')
@ApiTags('defects')
@ApiBearerAuth()
@Controller('defects')
export class DefectsController {
  constructor(private readonly defects: DefectsService) {}

  @Get()
  @Perm('dvir', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sort', required: false })
  @ApiQuery({ name: 'vehicleId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'severity', required: false })
  @ApiQuery({ name: 'outOfService', required: false })
  @ApiQuery({ name: 'assigneeId', required: false })
  @ApiOperation({ summary: 'Lists defects raised on DVIRs.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'def_1', vehicleId: 'veh_1', severity: 'CRITICAL', status: 'OPEN', outOfService: true }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  list(@Query(zodBody(DefectListQueryDto)) query: DefectListQueryDto) {
    return this.defects.list(query);
  }

  @Get(':id')
  @Perm('dvir', 'READ')
  @ApiOperation({ summary: 'Gets one defect.' })
  @ApiOkResponse({ schema: { example: { id: 'def_1', vehicleId: 'veh_1', severity: 'CRITICAL', status: 'OPEN' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DEFECT_NOT_FOUND, 'Defect not found.')] })
  get(@Param('id') id: string) {
    return this.defects.get(id);
  }

  @Patch(':id/resolve')
  @Perm('dvir', 'FULL')
  @Audit({ object: 'Defect', action: 'RESOLVE' })
  @ApiOperation({ summary: 'Resolves a defect (resolutionType REPAIRED/NOT_REQUIRED/DEFERRED, plus B-70 repair-record fields). Restores the unit from OUT_OF_SERVICE if it was the last open CRITICAL defect. NOT_REQUIRED is never recorded as a repair.' })
  @ApiOkResponse({ schema: { example: { id: 'def_1', status: 'REPAIRED', resolutionType: 'REPAIRED', resolvedAt: '2026-09-11T15:41:00.000Z' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DEFECT_NOT_FOUND, 'Defect not found.')] })
  resolve(@Param('id') id: string, @Body(zodBody(ResolveDefectDto)) dto: ResolveDefectDto, @CurrentUser('id') userId: string) {
    return this.defects.resolve(id, dto, userId);
  }

  @Patch(':id/assign')
  @Perm('dvir', 'FULL')
  @Audit({ object: 'Defect', action: 'ASSIGN' })
  @ApiOperation({ summary: 'Sets (or clears, with `assigneeId: null`) the defect assignee/shop (B-40, W-09 ASSIGNED TO).' })
  @ApiOkResponse({ schema: { example: { id: 'def_1', assigneeId: 'usr_2' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DEFECT_NOT_FOUND, 'Defect not found.')] })
  assign(@Param('id') id: string, @Body(zodBody(AssignDefectDto)) dto: AssignDefectDto) {
    return this.defects.assign(id, dto);
  }

  @Patch(':id/work-order')
  @Perm('dvir', 'FULL')
  @Audit({ object: 'Defect', action: 'LINK_WORK_ORDER' })
  @ApiOperation({ summary: 'Attaches (or detaches, with `workOrderId: null`) a defect to a work order.' })
  @ApiOkResponse({ schema: { example: { id: 'def_1', workOrderId: 'wo_1' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DEFECT_NOT_FOUND, 'Defect not found.')] })
  linkWorkOrder(@Param('id') id: string, @Body(zodBody(LinkDefectWorkOrderDto)) dto: LinkDefectWorkOrderDto) {
    return this.defects.linkWorkOrder(id, dto);
  }
}
