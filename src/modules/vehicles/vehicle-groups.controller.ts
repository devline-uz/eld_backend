import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CreateVehicleGroupDto, SetVehicleGroupMembersDto, UpdateVehicleGroupDto } from './dto/vehicles.dto';
import { VehicleGroupsService } from './vehicle-groups.service';

const GROUP_EXAMPLE = {
  id: 'vg_1',
  name: 'Midwest linehaul',
  description: 'OH/IN/KY lanes',
  color: '#2F6FED',
  vehicleCount: 14,
  createdAt: '2026-09-25T09:00:00.000Z',
  updatedAt: '2026-09-25T09:00:00.000Z',
};

/** Vehicle groups — W-12 IFTA `Vehicle group` filter and W-13 Activity `Group by`; gated by `vehicles`. */
@FigmaScreen('web/vehicles')
@ApiTags('vehicle-groups')
@ApiBearerAuth()
@Controller('vehicle-groups')
export class VehicleGroupsController {
  constructor(private readonly groups: VehicleGroupsService) {}

  @Get()
  @Perm('vehicles', 'READ')
  @ApiOperation({ summary: 'Lists vehicle groups (name order) with their unit counts.' })
  @ApiOkResponse({ schema: { example: { items: [GROUP_EXAMPLE] } } })
  @ApiStandardErrors()
  async list() {
    return { items: await this.groups.list() };
  }

  @Get(':id')
  @Perm('vehicles', 'READ')
  @ApiOperation({ summary: 'Gets one vehicle group with its units.' })
  @ApiOkResponse({ schema: { example: { ...GROUP_EXAMPLE, vehicles: [{ id: 'veh_1', unitNumber: '101', vin: '1FUJGLDR8LLLL1234', make: 'Freightliner', model: 'Cascadia', status: 'ACTIVE' }] } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_GROUP_NOT_FOUND, 'Vehicle group not found.')] })
  get(@Param('id') id: string) {
    return this.groups.get(id);
  }

  @Post()
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'VehicleGroup', action: 'CREATE' })
  @ApiOperation({ summary: 'Creates a vehicle group; optional `vehicleIds` move those units into it.' })
  @ApiCreatedResponse({ schema: { example: GROUP_EXAMPLE } })
  @ApiStandardErrors({
    errors: [
      apiError.conflict(ERROR_CODES.CONFLICT, 'A vehicle group with this name already exists.'),
      apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.'),
    ],
  })
  create(@Body(zodBody(CreateVehicleGroupDto)) dto: CreateVehicleGroupDto) {
    return this.groups.create(dto);
  }

  @Patch(':id')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'VehicleGroup', action: 'UPDATE' })
  @ApiOperation({ summary: 'Renames / recolours a vehicle group.' })
  @ApiOkResponse({ schema: { example: GROUP_EXAMPLE } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.VEHICLE_GROUP_NOT_FOUND, 'Vehicle group not found.'),
      apiError.conflict(ERROR_CODES.CONFLICT, 'A vehicle group with this name already exists.'),
    ],
  })
  update(@Param('id') id: string, @Body(zodBody(UpdateVehicleGroupDto)) dto: UpdateVehicleGroupDto) {
    return this.groups.update(id, dto);
  }

  @Put(':id/vehicles')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'VehicleGroup', action: 'SET_MEMBERS' })
  @ApiOperation({ summary: 'Replaces the group membership with exactly `vehicleIds` (units not listed leave the group; listed units move in from any other group).' })
  @ApiOkResponse({ schema: { example: GROUP_EXAMPLE } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.VEHICLE_GROUP_NOT_FOUND, 'Vehicle group not found.'),
      apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.'),
    ],
  })
  setMembers(@Param('id') id: string, @Body(zodBody(SetVehicleGroupMembersDto)) dto: SetVehicleGroupMembersDto) {
    return this.groups.setMembers(id, dto);
  }

  @Delete(':id')
  @Perm('vehicles', 'FULL')
  @Audit({ object: 'VehicleGroup', action: 'DELETE' })
  @ApiOperation({ summary: 'Deletes a vehicle group; its units stay, ungrouped.' })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_GROUP_NOT_FOUND, 'Vehicle group not found.')] })
  async remove(@Param('id') id: string) {
    await this.groups.remove(id);
    return { success: true };
  }
}
