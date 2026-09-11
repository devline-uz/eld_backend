import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import {
  AssignDriverDto,
  CalibrateOdometerDto,
  CreateVehicleDto,
  ImportVehiclesDto,
  UpdateVehicleDto,
  VehicleListQueryDto,
} from './dto/vehicles.dto';
import { VehiclesService } from './vehicles.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';

/** TZ §5.3 / §4.3 — "Vehicles" and "Unit detail" Figma screens, gated by `vehicles`. */
@FigmaScreen('web/vehicles', 'web/vehicle-add')
@ApiTags('vehicles')
@ApiBearerAuth()
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Get()
  @Perm('vehicles', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sort', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiOperation({ summary: 'Lists vehicles — unit number, VIN, odometer, status (TZ §5.3 "Vehicles" screen).' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'veh_1', unitNumber: '#101', vin: '1FUJA6CV88LW12345', status: 'ACTIVE' }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  list(@Query(zodBody(VehicleListQueryDto)) query: VehicleListQueryDto) {
    return this.vehicles.list(query);
  }

  @Get('export')
  @Perm('vehicles', 'READ')
  @ApiOperation({ summary: 'Exports all vehicles as the same shape `POST /vehicles/import` accepts (round-trips without loss).' })
  @ApiOkResponse({ description: 'Every unit in the import payload shape.', schema: { example: { vehicles: [{ unitNumber: '101', vin: '1FUJGLDR8LLLL1234', make: 'Freightliner', model: 'Cascadia', year: 2021, fuelType: 'DIESEL', odometerMiles: 993107 }] } } })
  @ApiStandardErrors()
  export() {
    return this.vehicles.exportAll();
  }

  @Get(':id')
  @Perm('vehicles', 'READ')
  @ApiOperation({ summary: 'Gets one vehicle (TZ §5.3 "Unit detail" screen).' })
  @ApiOkResponse({ schema: { example: { id: 'veh_1', unitNumber: '101', vin: '1FUJGLDR8LLLL1234', make: 'Freightliner', model: 'Cascadia', year: 2021, status: 'ACTIVE', odometerMiles: 993107, odometerOffsetMiles: 12, assignedDriverId: 'drv_1' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.')] })
  get(@Param('id') id: string) {
    return this.vehicles.get(id);
  }

  @Post()
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Vehicle', action: 'CREATE' })
  @ApiOperation({ summary: 'Adds a unit (VIN, dash odometer at add-time per TZ §4.3 step 1).' })
  @ApiCreatedResponse({ schema: { example: { id: 'veh_9', unitNumber: '126', vin: '1FUJHHDR5NLNN4410', status: 'ACTIVE', odometerMiles: 221449 } } })
  @ApiStandardErrors({ errors: [apiError.conflict(ERROR_CODES.CONFLICT, 'A unit with this unit number or VIN already exists.')] })
  create(@Body(zodBody(CreateVehicleDto)) dto: CreateVehicleDto) {
    return this.vehicles.create(dto);
  }

  @Post('import')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Vehicle', action: 'IMPORT' })
  @ApiOperation({ summary: 'Bulk-imports vehicles; upserts by `unitNumber`/`vin`.' })
  @ApiOkResponse({ schema: { example: { imported: 2, updated: 0, failed: [] } } })
  @ApiStandardErrors({ errors: [apiError.unprocessable(ERROR_CODES.IMPORT_FAILED, 'One or more rows could not be imported.')] })
  import(@Body(zodBody(ImportVehiclesDto)) dto: ImportVehiclesDto) {
    return this.vehicles.importMany(dto);
  }

  @Patch(':id')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Vehicle', action: 'UPDATE' })
  @ApiOperation({ summary: 'Edits a unit.' })
  @ApiOkResponse({ schema: { example: { id: 'veh_1', unitNumber: '101', status: 'ACTIVE', licensePlate: 'PQR-4821', licenseState: 'OH' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.')] })
  update(@Param('id') id: string, @Body(zodBody(UpdateVehicleDto)) dto: UpdateVehicleDto) {
    return this.vehicles.update(id, dto);
  }

  @Delete(':id')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Vehicle', action: 'DELETE' })
  @ApiOperation({ summary: 'Soft-deletes a unit (status -> INACTIVE, unassigns its driver). Never hard-deletes — see bugs.md B-009.' })
  @ApiOkResponse({ description: 'Soft-deleted — status INACTIVE, driver unassigned.', schema: { example: { id: 'veh_1', status: 'INACTIVE', assignedDriverId: null } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.')] })
  remove(@Param('id') id: string) {
    return this.vehicles.remove(id);
  }

  @Post(':id/calibrate-odometer')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Vehicle', action: 'CALIBRATE_ODOMETER' })
  @ApiOperation({ summary: 'TZ §4.3 step 4 — recalibrates the odometer offset against the PT30 reading. Always audited.' })
  @ApiCreatedResponse({ description: 'New offset = dash reading − device reading (TZ §4.3 step 4); the change is audited.', schema: { example: { id: 'veh_1', odometerOffsetMiles: 12, dashOdometerMiles: 993119, deviceOdometerMiles: 993107 } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.'), apiError.unprocessable(ERROR_CODES.ODOMETER_ANOMALY, 'Reading differs from the recorded odometer by more than the allowed tolerance.')] })
  calibrateOdometer(@Param('id') id: string, @Body(zodBody(CalibrateOdometerDto)) dto: CalibrateOdometerDto) {
    return this.vehicles.calibrateOdometer(id, dto);
  }

  @Post(':id/assign-driver')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Vehicle', action: 'ASSIGN_DRIVER' })
  @ApiOperation({ summary: 'Assigns a driver to this unit. Blocked while the unit is OUT_OF_SERVICE.' })
  @ApiCreatedResponse({ schema: { example: { id: 'veh_1', unitNumber: '101', assignedDriverId: 'drv_1' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.'), apiError.conflict(ERROR_CODES.VEHICLE_OUT_OF_SERVICE, 'Unit is OUT_OF_SERVICE — assign a driver only after the critical defect is closed.')] })
  assignDriver(@Param('id') id: string, @Body(zodBody(AssignDriverDto)) dto: AssignDriverDto) {
    return this.vehicles.assignDriver(id, dto);
  }

  @Post(':id/unassign-driver')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Vehicle', action: 'UNASSIGN_DRIVER' })
  @ApiOperation({ summary: 'Clears the driver currently assigned to this unit, if any.' })
  @ApiCreatedResponse({ schema: { example: { id: 'veh_1', unitNumber: '101', assignedDriverId: null } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.')] })
  unassignDriver(@Param('id') id: string) {
    return this.vehicles.unassignDriver(id);
  }
}
