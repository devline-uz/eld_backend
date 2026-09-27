import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Perm, PermAny } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import {
  AssignDriverDto,
  BulkUpdateVehicleStatusDto,
  CalibrateOdometerDto,
  CreateVehicleDto,
  ImportVehiclesDto,
  UpdateVehicleDto,
  VehicleHistoriesQueryDto,
  VehicleListQueryDto,
  VehicleTelemetryQueryDto,
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
  @ApiQuery({ name: 'groupId', required: false, description: 'A vehicle-group id, or `none` for ungrouped units.' })
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

  @Get(':id/activities')
  @Perm('vehicles', 'READ')
  @ApiOperation({ summary: 'B-5 — "Unit activity" feed (audit trail + DVIR submissions for this unit).' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'dvir_1', occurredAt: '2026-09-24T13:00:00.000Z', activity: 'DVIR_PRE_TRIP', driverName: 'John Smith', source: 'DVIR', details: 'SATISFACTORY' }] } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.')] })
  async activities(@Param('id') id: string) {
    return { items: await this.vehicles.activities(id) };
  }

  @Get(':id/histories')
  @Perm('vehicles', 'READ')
  @ApiQuery({ name: 'date', required: true, description: 'YYYY-MM-DD, in the assigned driver / carrier home-terminal timezone.' })
  @ApiOperation({ summary: 'B-4 — W-05 Unit histories: server-side DRIVE/STOP/IDLE day segmentation (never raw telemetry to the browser).' })
  @ApiOkResponse({ schema: { example: { date: '2026-09-24', distanceMi: 312.4, driveSegments: 3, driveTimeSec: 21600, avgSpeedMph: 52, stopCount: 2, stopTimeSec: 5400, idleTimeSec: 900, idleFuelWastedGal: 0.6, firstMovementAt: '2026-09-24T11:00:00.000Z', lastMovementAt: '2026-09-24T23:00:00.000Z', engineOnSec: 22500, engineOffSec: 5400, longestDrive: { label: '40.7128, -74.0060', durationSec: 10800 }, longestStop: { label: '39.9612, -82.9988', durationSec: 3600 }, maxSpeedMph: 68, maxSpeedAt: '2026-09-24T15:00:00.000Z', segments: [] } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.'), apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'Invalid date.')] })
  histories(@Param('id') id: string, @Query(zodBody(VehicleHistoriesQueryDto)) query: VehicleHistoriesQueryDto) {
    return this.vehicles.histories(id, query.date);
  }

  @Get(':id/telemetry')
  @Perm('vehicles', 'READ')
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOperation({ summary: 'Telemetry read path (Virtual Dashboard, TZ §5.6) — most recent points for this unit, newest first.' })
  @ApiOkResponse({ schema: { example: { items: [{ time: '2026-09-24T15:00:00.000Z', vehicleId: 'veh_1', speedMph: 62, latitude: 40.7128, longitude: -74.006 }] } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.')] })
  async telemetry(@Param('id') id: string, @Query(zodBody(VehicleTelemetryQueryDto)) query: VehicleTelemetryQueryDto) {
    return { items: await this.vehicles.telemetryRecent(id, query) };
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
  @ApiOkResponse({ schema: { example: { imported: 2, updated: 0, skipped: 0, failed: [] } } })
  @ApiStandardErrors({ errors: [apiError.unprocessable(ERROR_CODES.IMPORT_FAILED, 'One or more rows could not be imported.')] })
  import(@Body(zodBody(ImportVehiclesDto)) dto: ImportVehiclesDto, @CurrentUser('id') actorUserId?: string) {
    return this.vehicles.importMany(dto, actorUserId);
  }

  @Patch('bulk-status')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Vehicle', action: 'BULK_UPDATE_STATUS' })
  @ApiOperation({ summary: 'B-71 — updates `status` on many units in one call; each row goes through the OOS hard rule independently.' })
  @ApiOkResponse({ schema: { example: { updated: ['veh_1', 'veh_2'], failed: [] } } })
  @ApiStandardErrors()
  bulkUpdateStatus(@Body(zodBody(BulkUpdateVehicleStatusDto)) dto: BulkUpdateVehicleStatusDto) {
    return this.vehicles.bulkUpdateStatus(dto);
  }

  @Patch(':id')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'Vehicle', action: 'UPDATE' })
  @ApiOperation({ summary: 'Edits a unit.' })
  @ApiOkResponse({ schema: { example: { id: 'veh_1', unitNumber: '101', status: 'ACTIVE', licensePlate: 'PQR-4821', licenseState: 'OH' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.'), apiError.conflict(ERROR_CODES.VEHICLE_HAS_OPEN_CRITICAL_DEFECTS, 'Unit has open critical defects and cannot leave OUT_OF_SERVICE.')] })
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
  // B-13 — a dispatcher (vehicles:READ, trips:FULL) may still assign a driver to a unit.
  @PermAny(['vehicles', 'FULL'], ['trips', 'FULL'])
  @Audit({ object: 'Vehicle', action: 'ASSIGN_DRIVER' })
  @ApiOperation({ summary: 'Assigns a driver to this unit. Blocked while the unit is OUT_OF_SERVICE. Requires vehicles:FULL or trips:FULL (B-13).' })
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
