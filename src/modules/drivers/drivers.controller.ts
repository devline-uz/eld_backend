import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CreateDriverDto, DriverListQueryDto, ImportDriversDto, UpdateDriverDto } from './dto/drivers.dto';
import { DriversService } from './drivers.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';

/** TZ §5.3 — "Drivers" and "Driver profile" Figma screens, gated by the `drivers` permission key. */
@FigmaScreen('web/drivers', 'web/driver-add')
@ApiTags('drivers')
@ApiBearerAuth()
@Controller('drivers')
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get()
  @Perm('drivers', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sort', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiOperation({ summary: 'Lists drivers with CDL, exceptions, and status (TZ §5.3).' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'drv_1', username: 'jsmith', cdlNumber: 'D1234567' }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  list(@Query(zodBody(DriverListQueryDto)) query: DriverListQueryDto) {
    return this.drivers.list(query);
  }

  @Get('export')
  @Perm('drivers', 'READ')
  @ApiOperation({ summary: 'Exports all drivers as the same shape `POST /drivers/import` accepts (round-trips without loss, minus passwords).' })
  @ApiOkResponse({ description: 'Every driver in the import payload shape.', schema: { example: { drivers: [{ username: 'jsmith', firstName: 'John', lastName: 'Smith', cdlNumber: 'W8569238', cdlState: 'OH', homeTerminalTimezone: 'America/New_York', hosRuleset: 'US_70_8_PROPERTY' }] } } })
  @ApiStandardErrors()
  export() {
    return this.drivers.exportAll();
  }

  @Get(':id')
  @Perm('drivers', 'READ')
  @ApiOperation({ summary: 'Gets one driver profile.' })
  @ApiOkResponse({ schema: { example: { id: 'drv_1', username: 'jsmith', firstName: 'John', lastName: 'Smith', status: 'ACTIVE', cdlNumber: 'W8569238', cdlState: 'OH', homeTerminalTimezone: 'America/New_York', assignedVehicleId: 'veh_1', allowPersonalConveyance: true, allowYardMove: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.')] })
  get(@Param('id') id: string) {
    return this.drivers.get(id);
  }

  @Post()
  @Perm('drivers', 'FULL')
  @Audit({ object: 'Driver', action: 'CREATE' })
  @ApiOperation({ summary: 'Creates a driver (CDL, home terminal timezone, HOS ruleset, exception flags).' })
  @ApiCreatedResponse({ schema: { example: { id: 'drv_9', username: 'awebb', status: 'ACTIVE', homeTerminalTimezone: 'America/New_York' } } })
  @ApiStandardErrors({ errors: [apiError.conflict(ERROR_CODES.CONFLICT, 'A driver with this username already exists.')] })
  create(@Body(zodBody(CreateDriverDto)) dto: CreateDriverDto) {
    return this.drivers.create(dto);
  }

  @Post('import')
  @Perm('drivers', 'FULL')
  @Audit({ object: 'Driver', action: 'IMPORT' })
  @ApiOperation({ summary: 'Bulk-imports drivers; upserts by `username`.' })
  @ApiOkResponse({ schema: { example: { imported: 3, updated: 1, failed: [] } } })
  @ApiStandardErrors({ errors: [apiError.unprocessable(ERROR_CODES.IMPORT_FAILED, 'One or more rows could not be imported.')] })
  import(@Body(zodBody(ImportDriversDto)) dto: ImportDriversDto) {
    return this.drivers.importMany(dto);
  }

  @Patch(':id')
  @Perm('drivers', 'FULL')
  @Audit({ object: 'Driver', action: 'UPDATE' })
  @ApiOperation({ summary: 'Updates a driver profile, CDL, or exception flags.' })
  @ApiOkResponse({ schema: { example: { id: 'drv_1', username: 'jsmith', status: 'ACTIVE', allowPersonalConveyance: false } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.')] })
  update(@Param('id') id: string, @Body(zodBody(UpdateDriverDto)) dto: UpdateDriverDto) {
    return this.drivers.update(id, dto);
  }

  @Delete(':id')
  @Perm('drivers', 'FULL')
  @Audit({ object: 'Driver', action: 'DELETE' })
  @ApiOperation({ summary: 'Soft-deletes a driver (status -> TERMINATED, unassigns their unit). Never hard-deletes — see bugs.md B-009.' })
  @ApiOkResponse({ description: 'Soft-deleted — status is TERMINATED, the unit is unassigned.', schema: { example: { id: 'drv_1', status: 'TERMINATED', assignedVehicleId: null } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.')] })
  remove(@Param('id') id: string) {
    return this.drivers.remove(id);
  }
}
