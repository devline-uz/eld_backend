import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { AssignTripDto, CreateTripDto, TripListQueryDto, UpdateTripDto } from './dto/trips.dto';
import { TripsService } from './trips.service';

/** TZ §11.5 — dispatch & trip lifecycle, gated by `trips` (DISPATCHER has FULL — §6.4). */
@FigmaScreen('web/dispatch-trips')
@ApiTags('trips')
@ApiBearerAuth()
@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Get()
  @Perm('trips', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiOperation({ summary: 'Lists trips/loads with dispatch status.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'trp_1', number: 'TRP-1001', status: 'PLANNED' }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  list(@Query(zodBody(TripListQueryDto)) query: TripListQueryDto) {
    return this.trips.list(query);
  }

  @Get('unassigned-loads')
  @Perm('trips', 'READ')
  @ApiOperation({ summary: 'Loads with no driver assigned yet (dispatch board "unassigned" column).' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'trp_2', number: 'TRP-1002', status: 'PLANNED' }] } } })
  @ApiStandardErrors()
  unassigned() {
    return this.trips.unassignedLoads().then((items) => ({ items }));
  }

  @Get(':id')
  @Perm('trips', 'READ')
  @ApiOperation({ summary: 'One trip with its stops.' })
  @ApiOkResponse({ schema: { example: { id: 'trp_1', number: 'TRP-1001', status: 'ASSIGNED', stops: [] } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Trip not found.')] })
  get(@Param('id') id: string) {
    return this.trips.get(id);
  }

  @Post()
  @Perm('trips', 'FULL')
  @Audit({ object: 'Trip', action: 'CREATE' })
  @ApiOperation({ summary: 'Creates a trip/load, optionally with stops and an initial driver/vehicle.' })
  @ApiCreatedResponse({ schema: { example: { id: 'trp_3', number: 'TRP-1003', status: 'PLANNED' } } })
  @ApiStandardErrors({ errors: [apiError.conflict(ERROR_CODES.CONFLICT, 'A trip with this number already exists.'), apiError.unprocessable(ERROR_CODES.TRAILER_NOT_FOUND, 'trailerId is unknown or names a deleted trailer.')] })
  create(@Body(zodBody(CreateTripDto)) dto: CreateTripDto, @CurrentUser() actor: ContextUser) {
    return this.trips.create(dto, actor.id);
  }

  @Patch(':id')
  @Perm('trips', 'FULL')
  @Audit({ object: 'Trip', action: 'UPDATE' })
  @ApiOperation({ summary: 'Updates trip fields or advances its lifecycle status.' })
  @ApiOkResponse({ schema: { example: { id: 'trp_1', status: 'IN_PROGRESS' } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Trip not found.'),
      apiError.conflict(ERROR_CODES.CONFLICT, 'Illegal status transition.'),
    ],
  })
  update(@Param('id') id: string, @Body(zodBody(UpdateTripDto)) dto: UpdateTripDto) {
    return this.trips.update(id, dto);
  }

  @Post(':id/assign')
  @Perm('trips', 'FULL')
  @Audit({ object: 'Trip', action: 'ASSIGN' })
  @ApiOperation({ summary: 'Assigns (or reassigns) a driver/vehicle/trailer to a trip.' })
  @ApiOkResponse({ schema: { example: { id: 'trp_2', status: 'ASSIGNED', driverId: 'drv_1' } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Trip not found.'),
      apiError.conflict(ERROR_CODES.CONFLICT, 'Only a planned or assigned trip can be (re)assigned.'),
      apiError.unprocessable(ERROR_CODES.TRAILER_NOT_FOUND, 'trailerId is unknown or names a deleted trailer.'),
    ],
  })
  assign(@Param('id') id: string, @Body(zodBody(AssignTripDto)) dto: AssignTripDto) {
    return this.trips.assign(id, dto);
  }

  @Post('auto-assign')
  @Perm('trips', 'FULL')
  @Audit({ object: 'Trip', action: 'AUTO_ASSIGN' })
  @ApiOperation({ summary: 'Greedily assigns every unassigned load to the next free ACTIVE driver.' })
  @ApiOkResponse({ schema: { example: { assigned: [{ tripId: 'trp_2', driverId: 'drv_1' }], skipped: 0 } } })
  @ApiStandardErrors()
  autoAssign() {
    return this.trips.autoAssign();
  }
}
