import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import {
  CompleteMaintenanceDto,
  CreateMaintenanceScheduleDto,
  MaintenanceScheduleListQueryDto,
  UpdateMaintenanceScheduleDto,
} from './dto/service.dto';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

/** TZ §5.10 — maintenance scheduling (interval by mileage/date), due + overdue surfaced per
 * schedule; the nightly `maintenance-due` BullMQ job (workers/maintenance-due.processor.ts)
 * raises an alert for the same detection. */
@FigmaScreen('web/dvir-maintenance')
@ApiTags('maintenance')
@ApiBearerAuth()
@Controller('maintenance-schedules')
export class MaintenanceSchedulesController {
  constructor(private readonly schedules: MaintenanceSchedulesService) {}

  @Get()
  @Perm('maintenance', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'vehicleId', required: false })
  @ApiQuery({ name: 'enabled', required: false })
  @ApiQuery({ name: 'dueOnly', required: false, description: 'Only schedules currently DUE_SOON or OVERDUE.' })
  @ApiOperation({ summary: 'Lists maintenance schedules with computed due state.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'ms_1', vehicleId: 'veh_1', name: 'Brake service', intervalMi: 25000, due: { state: 'DUE_SOON', nextDueMi: 995000, milesRemaining: 300 } }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  list(@Query(zodBody(MaintenanceScheduleListQueryDto)) query: MaintenanceScheduleListQueryDto) {
    return this.schedules.list(query);
  }

  @Get(':id')
  @Perm('maintenance', 'READ')
  @ApiOperation({ summary: 'Gets one maintenance schedule with computed due state.' })
  @ApiOkResponse({ schema: { example: { id: 'ms_1', vehicleId: 'veh_1', name: 'Brake service', due: { state: 'OK' } } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.MAINTENANCE_SCHEDULE_NOT_FOUND, 'Maintenance schedule not found.')] })
  get(@Param('id') id: string) {
    return this.schedules.get(id);
  }

  @Post()
  @Perm('maintenance', 'FULL')
  @Audit({ object: 'MaintenanceSchedule', action: 'CREATE' })
  @ApiOperation({ summary: 'Creates a maintenance schedule ("Brake service", "DOT annual inspection", ...).' })
  @ApiCreatedResponse({ schema: { example: { id: 'ms_9', vehicleId: 'veh_1', name: 'DOT annual inspection', intervalDays: 365 } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.')] })
  create(@Body(zodBody(CreateMaintenanceScheduleDto)) dto: CreateMaintenanceScheduleDto) {
    return this.schedules.create(dto);
  }

  @Patch(':id')
  @Perm('maintenance', 'FULL')
  @Audit({ object: 'MaintenanceSchedule', action: 'UPDATE' })
  @ApiOperation({ summary: 'Edits a maintenance schedule.' })
  @ApiOkResponse({ schema: { example: { id: 'ms_1', enabled: false } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.MAINTENANCE_SCHEDULE_NOT_FOUND, 'Maintenance schedule not found.')] })
  update(@Param('id') id: string, @Body(zodBody(UpdateMaintenanceScheduleDto)) dto: UpdateMaintenanceScheduleDto) {
    return this.schedules.update(id, dto);
  }

  @Delete(':id')
  @Perm('maintenance', 'FULL')
  @Audit({ object: 'MaintenanceSchedule', action: 'DELETE' })
  @ApiOperation({ summary: 'Deletes a maintenance schedule.' })
  @ApiOkResponse({ schema: { example: { deleted: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.MAINTENANCE_SCHEDULE_NOT_FOUND, 'Maintenance schedule not found.')] })
  async remove(@Param('id') id: string) {
    await this.schedules.remove(id);
    return { deleted: true };
  }

  @Post(':id/complete')
  @Perm('maintenance', 'FULL')
  @Audit({ object: 'MaintenanceSchedule', action: 'COMPLETE' })
  @ApiOperation({ summary: 'Marks a schedule serviced now, resetting the interval clock.' })
  @ApiCreatedResponse({ schema: { example: { id: 'ms_1', lastServiceMi: 994700, nextDueMi: 1019700 } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.MAINTENANCE_SCHEDULE_NOT_FOUND, 'Maintenance schedule not found.')] })
  complete(@Param('id') id: string, @Body(zodBody(CompleteMaintenanceDto)) dto: CompleteMaintenanceDto) {
    return this.schedules.complete(id, dto);
  }
}
