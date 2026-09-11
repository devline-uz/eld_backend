import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CreateWorkOrderDto, UpdateWorkOrderDto, WorkOrderListQueryDto } from './dto/service.dto';
import { WorkOrdersService } from './work-orders.service';

/** TZ §5.10 — "Create work order" screen: work order lifecycle (OPEN -> IN_PROGRESS -> DONE
 * / CANCELLED), cost and parts (`vendor`/`costUsd`), and the attached-defect resolution gate
 * on close. */
@FigmaScreen('web/create-work-order')
@ApiTags('work-orders')
@ApiBearerAuth()
@Controller('work-orders')
export class WorkOrdersController {
  constructor(private readonly workOrders: WorkOrdersService) {}

  @Get()
  @Perm('maintenance', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sort', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'vehicleId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiOperation({ summary: 'Lists work orders.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'wo_1', number: 'WO-0001', vehicleId: 'veh_1', status: 'OPEN', priority: 'NORMAL' }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  list(@Query(zodBody(WorkOrderListQueryDto)) query: WorkOrderListQueryDto) {
    return this.workOrders.list(query);
  }

  @Get(':id')
  @Perm('maintenance', 'READ')
  @ApiOperation({ summary: 'Gets one work order.' })
  @ApiOkResponse({ schema: { example: { id: 'wo_1', number: 'WO-0001', vehicleId: 'veh_1', status: 'OPEN' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.WORK_ORDER_NOT_FOUND, 'Work order not found.')] })
  get(@Param('id') id: string) {
    return this.workOrders.get(id);
  }

  @Post()
  @Perm('maintenance', 'FULL')
  @Audit({ object: 'WorkOrder', action: 'CREATE' })
  @ApiOperation({ summary: 'Creates a work order (TZ §5.10 "Create work order" screen), optionally attaching open defects.' })
  @ApiCreatedResponse({ schema: { example: { id: 'wo_9', number: 'WO-0009', vehicleId: 'veh_1', status: 'OPEN', priority: 'NORMAL' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.')] })
  create(@Body(zodBody(CreateWorkOrderDto)) dto: CreateWorkOrderDto, @CurrentUser('id') userId: string) {
    return this.workOrders.create(dto, userId);
  }

  @Patch(':id')
  @Perm('maintenance', 'FULL')
  @Audit({ object: 'WorkOrder', action: 'UPDATE' })
  @ApiOperation({ summary: 'Edits a work order (title, priority, vendor, cost, due date). Blocked once DONE/CANCELLED.' })
  @ApiOkResponse({ schema: { example: { id: 'wo_1', status: 'IN_PROGRESS', costUsd: '420.00' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.WORK_ORDER_NOT_FOUND, 'Work order not found.'), apiError.conflict(ERROR_CODES.WORK_ORDER_CLOSED, 'Work order is already closed or cancelled.')] })
  update(@Param('id') id: string, @Body(zodBody(UpdateWorkOrderDto)) dto: UpdateWorkOrderDto) {
    return this.workOrders.update(id, dto);
  }

  @Post(':id/close')
  @Perm('maintenance', 'FULL')
  @Audit({ object: 'WorkOrder', action: 'CLOSE' })
  @ApiOperation({ summary: 'Closes a work order (status -> DONE). Requires every attached defect to already be resolved.' })
  @ApiCreatedResponse({ schema: { example: { id: 'wo_1', status: 'DONE', closedAt: '2026-09-11T15:41:00.000Z' } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.WORK_ORDER_NOT_FOUND, 'Work order not found.'),
      apiError.conflict(ERROR_CODES.WORK_ORDER_CLOSED, 'Work order is already closed or cancelled.'),
      apiError.conflict(ERROR_CODES.DEFECT_NOT_RESOLVED, 'One or more attached defects are not resolved yet.'),
    ],
  })
  close(@Param('id') id: string) {
    return this.workOrders.close(id);
  }

  @Post(':id/cancel')
  @Perm('maintenance', 'FULL')
  @Audit({ object: 'WorkOrder', action: 'CANCEL' })
  @ApiOperation({ summary: 'Cancels a work order.' })
  @ApiCreatedResponse({ schema: { example: { id: 'wo_1', status: 'CANCELLED' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.WORK_ORDER_NOT_FOUND, 'Work order not found.'), apiError.conflict(ERROR_CODES.WORK_ORDER_CLOSED, 'Work order is already closed or cancelled.')] })
  cancel(@Param('id') id: string) {
    return this.workOrders.cancel(id);
  }

  @Post(':id/defects/:defectId')
  @Perm('maintenance', 'FULL')
  @Audit({ object: 'WorkOrder', action: 'ATTACH_DEFECT' })
  @ApiOperation({ summary: 'Attaches an open defect to this work order.' })
  @ApiCreatedResponse({ schema: { example: { id: 'wo_1', status: 'OPEN' } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.WORK_ORDER_NOT_FOUND, 'Work order not found.'),
      apiError.notFound(ERROR_CODES.DEFECT_NOT_FOUND, 'Defect not found.'),
      apiError.conflict(ERROR_CODES.WORK_ORDER_CLOSED, 'Work order is already closed or cancelled.'),
    ],
  })
  attachDefect(@Param('id') id: string, @Param('defectId') defectId: string) {
    return this.workOrders.attachDefect(id, defectId);
  }
}
