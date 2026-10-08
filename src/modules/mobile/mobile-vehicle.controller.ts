import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import type { ContextUser } from '../../core/context/request-context';
import { AvailableVehiclesQueryDto, ReleaseVehicleDto, SelectVehicleDto } from './dto/mobile-fleet-ops.dto';
import { AvailableVehicleResponse, ReleaseVehicleResponse, SelectedVehicleResponse } from './dto/mobile.responses';
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
  @ApiQuery({ name: 'q', required: false, description: 'MR-32 — substring of unit number / VIN / make / model / device serial (case-insensitive).' })
  @ApiQuery({ name: 'limit', required: false, description: 'MR-32 — 1-200; absent = no cap. The body stays a plain array either way.' })
  @ApiEnvelopeResponse(AvailableVehicleResponse, { isArray: true, example: [{ id: 'veh_1', unitNumber: '104', make: 'Freightliner', model: 'Cascadia', deviceSerial: 'PT30-1004' }] })
  @ApiStandardErrors()
  list(@Query(zodBody(AvailableVehiclesQueryDto)) query: AvailableVehiclesQueryDto, @CurrentUser('id') driverId: string) {
    return this.service.availableVehicles(driverId, query);
  }

  @Post('release-vehicle')
  @HttpCode(200)
  @ApiOperation({
    summary: 'MR-2 — releases the calling driver\'s assigned unit so other drivers see it in `available-vehicles`.',
    description:
      'Clears `Driver.assignedVehicleId`. If the driver is in an active co-driver pairing ON THAT UNIT the pairing is ended too ' +
      '(`endedById` = caller). Idempotent on `clientId`: a replay returns the first `{released:true, vehicleId}` instead of 409. ' +
      'Note `POST /mobile/co-driver/leave` DOES clear the leaving driver\'s unit, but only when an active pairing exists; without a pairing it returns `{ended:false}` and the unit is NOT released — use this endpoint for that case.',
  })
  @ApiEnvelopeResponse(ReleaseVehicleResponse, { example: { released: true, vehicleId: 'veh_1' } })
  @ApiStandardErrors({ errors: [apiError.conflict(ERROR_CODES.NO_ASSIGNED_VEHICLE, 'You have no assigned vehicle to release.')] })
  release(@Body(zodBody(ReleaseVehicleDto)) dto: ReleaseVehicleDto, @CurrentUser() actor: ContextUser) {
    return this.service.release(actor.id, dto, actor);
  }

  @Post('select-vehicle')
  @ApiOperation({ summary: 'M-03 — assigns a unit to the calling driver (`Driver.assignedVehicleId`).' })
  @ApiEnvelopeResponse(SelectedVehicleResponse, {
    status: 201,
    example: { id: 'veh_1', unitNumber: '104', vin: '1FUJA6CV71LM12345', make: 'Freightliner', model: 'Cascadia', year: 2021, sleeperBerth: true, status: 'ACTIVE', odometerMi: 84213, device: { id: 'dev_1', serial: 'PT30-1004', model: 'PT30' } },
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
