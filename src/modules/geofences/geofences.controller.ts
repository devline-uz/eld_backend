import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CreateGeofenceDto, UpdateGeofenceDto } from './dto/geofences.dto';
import { GeofencesService } from './geofences.service';

/**
 * TZ §11.5 (`GET/POST /geofences`) — the "Geofences" chip on the Live Fleet map
 * (eld.docs/web/admin.txt §"Live Fleet" point 5). No dedicated permission key exists for
 * geofences in the §6.4 matrix; it is a Live Fleet map overlay, so it is gated by `liveFleet`.
 */
@FigmaScreen('web/live-fleet')
@ApiTags('geofences')
@ApiBearerAuth()
@Controller('geofences')
export class GeofencesController {
  constructor(private readonly geofences: GeofencesService) {}

  @Get()
  @Perm('liveFleet', 'READ')
  @ApiOperation({ summary: 'Lists all geofences drawn on the Live Fleet map.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'gf_1', name: 'Columbus Terminal', type: 'CIRCLE', radiusMi: 1, alertOnEnter: true, colour: 'BLUE', countAsYardMove: false, vehicleGroupId: null, vehicleGroupName: null }] } } })
  @ApiStandardErrors()
  list() {
    return this.geofences.list();
  }

  @Get(':id')
  @Perm('liveFleet', 'READ')
  @ApiOperation({ summary: 'One geofence.' })
  @ApiOkResponse({ schema: { example: { id: 'gf_1', name: 'Columbus Terminal', type: 'CIRCLE', colour: 'BLUE', countAsYardMove: false, vehicleGroupId: 'b1c2d3e4-0000-4000-8000-000000000001', vehicleGroupName: 'Northeast' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Geofence not found.')] })
  get(@Param('id') id: string) {
    return this.geofences.get(id);
  }

  @Post()
  @Perm('liveFleet', 'FULL')
  @Audit({ object: 'Geofence', action: 'CREATE' })
  @ApiOperation({ summary: 'Draws a new terminal/customer geofence (circle or polygon).' })
  @ApiCreatedResponse({ schema: { example: { id: 'gf_2', name: 'Cust. dock 4', type: 'CIRCLE', radiusMi: 0.5, colour: 'GREEN', countAsYardMove: true, vehicleGroupId: 'b1c2d3e4-0000-4000-8000-000000000001' } } })
  @ApiStandardErrors({
    errors: [
      apiError.validation('CIRCLE requires centerLat/centerLon/radiusMi; POLYGON requires polygon points.'),
      apiError.notFound(ERROR_CODES.VEHICLE_GROUP_NOT_FOUND, 'Vehicle group not found.'),
    ],
  })
  create(@Body(zodBody(CreateGeofenceDto)) dto: CreateGeofenceDto) {
    return this.geofences.create(dto);
  }

  @Patch(':id')
  @Perm('liveFleet', 'FULL')
  @Audit({ object: 'Geofence', action: 'UPDATE' })
  @ApiOperation({ summary: 'Updates a geofence.' })
  @ApiOkResponse({ schema: { example: { id: 'gf_1', enabled: false, vehicleGroupId: null } } })
  // One spec per status (ApiStandardErrors de-dupes on status); an unknown `vehicleGroupId`
  // is also a 404, with code VEHICLE_GROUP_NOT_FOUND (§20 B-104).
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Geofence not found.')] })
  update(@Param('id') id: string, @Body(zodBody(UpdateGeofenceDto)) dto: UpdateGeofenceDto) {
    return this.geofences.update(id, dto);
  }

  @Delete(':id')
  @Perm('liveFleet', 'FULL')
  @Audit({ object: 'Geofence', action: 'DELETE' })
  @ApiOperation({ summary: 'Removes a geofence.' })
  @ApiOkResponse({ schema: { example: { id: 'gf_1', deleted: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Geofence not found.')] })
  remove(@Param('id') id: string) {
    return this.geofences.remove(id);
  }
}
