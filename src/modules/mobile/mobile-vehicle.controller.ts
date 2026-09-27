import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { SelectVehicleDto } from './dto/mobile-fleet-ops.dto';
import { MobileVehicleService } from './mobile-vehicle.service';

/**
 * mobile/tz.md §21.1 MB-2, screen M-03 ("select your truck"). `GET /mobile/bootstrap`
 * already carries `availableVehicles` (see `MobileBootstrapService`); this is only the
 * write side, so it lives in its own controller per `mobile/decisions.md` MD-001.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile')
export class MobileVehicleController {
  constructor(private readonly service: MobileVehicleService) {}

  @Get('available-vehicles')
  @ApiOperation({ summary: 'M-03 — units this driver may select: their own unit, or an ACTIVE unit no other ACTIVE driver currently holds.' })
  @ApiOkResponse({ schema: { example: [{ id: 'veh_1', unitNumber: '104', make: 'Freightliner', model: 'Cascadia', deviceSerial: 'PT30-1004' }] } })
  @ApiStandardErrors()
  list(@CurrentUser('id') driverId: string) {
    return this.service.availableVehicles(driverId);
  }

  @Post('select-vehicle')
  @ApiOperation({ summary: 'M-03 — assigns a unit to the calling driver (`Driver.assignedVehicleId`).' })
  @ApiCreatedResponse({
    schema: { example: { id: 'veh_1', unitNumber: '104', vin: '1FUJA6CV71LM12345', make: 'Freightliner', model: 'Cascadia', year: 2021, sleeperBerth: true, status: 'ACTIVE', odometerMi: 84213 } },
  })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.'),
      apiError.unprocessable(ERROR_CODES.VEHICLE_OUT_OF_SERVICE, 'This unit is out of service and cannot be selected.'),
      apiError.conflict(ERROR_CODES.CONFLICT, 'This unit is already assigned to another active driver.'),
    ],
  })
  select(@Body(zodBody(SelectVehicleDto)) dto: SelectVehicleDto, @CurrentUser() actor: ContextUser) {
    return this.service.select(actor.id, dto, actor);
  }
}
