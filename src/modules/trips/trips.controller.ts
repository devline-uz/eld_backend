import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, type ApiErrorSpec, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { AssignTripDto, CreateTripDto, TripListQueryDto, UpdateTripDto } from './dto/trips.dto';
import { TripsService } from './trips.service';

/** Record-status 409s every trip assignment can raise, beyond the field-level schedule conflicts. */
const TRIP_ASSIGNEE_CONFLICTS =
  'Also: VEHICLE_OUT_OF_SERVICE (details.vehicleId: "This unit is out of service and cannot be assigned a trip."); CONFLICT (details.vehicleId: "This unit is inactive and cannot be assigned a trip."); CONFLICT (details.driverId: "This driver is inactive|terminated and cannot be assigned a trip.").';

function withTripAssigneeConflicts(spec: ApiErrorSpec): ApiErrorSpec {
  return { ...spec, description: `${spec.description} ${TRIP_ASSIGNEE_CONFLICTS}` };
}

/** Swagger keeps one response per status — the 422 example is the first, the description lists all. */
const TRIP_ASSIGNEE_NOT_FOUND: ApiErrorSpec = {
  ...apiError.unprocessable(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.'),
  details: { driverId: 'Driver not found.' },
  description:
    'One of: DRIVER_NOT_FOUND (details.driverId: "Driver not found." / "This driver has been deleted and cannot be assigned."); VEHICLE_NOT_FOUND (details.vehicleId: "Vehicle not found." / "This unit has been deleted and cannot be assigned."); TRAILER_NOT_FOUND (details.trailerId); VALIDATION_FAILED (details.plannedStartAt when a planned start is required, or other field errors).',
};

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
  @ApiStandardErrors({
    errors: [
      // Swagger keeps one response per status — `fieldConflicts` lists both 409s.
      withTripAssigneeConflicts(apiError.fieldConflicts([
        { code: ERROR_CODES.CONFLICT, field: 'number', message: 'A trip with this number already exists.' },
        { code: ERROR_CODES.TRIP_SCHEDULE_CONFLICT, field: 'vehicleId', message: 'Unit 1 is already assigned to another trip (TRP-1001) from 2026-10-10 12:00 UTC to 2026-10-20 12:00 UTC.' },
        { code: ERROR_CODES.TRIP_SCHEDULE_CONFLICT, field: 'driverId', message: 'Driver John Smith is already assigned to another trip (TRP-1001) from 2026-10-10 12:00 UTC to 2026-10-20 12:00 UTC.' },
        { code: ERROR_CODES.TRIP_SCHEDULE_CONFLICT, field: 'trailerId', message: 'Trailer T-12 is already assigned to another trip (TRP-1001) from 2026-10-10 12:00 UTC to 2026-10-20 12:00 UTC.' },
      ])),
      TRIP_ASSIGNEE_NOT_FOUND,
    ],
  })
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
      apiError.fieldConflicts([
        { code: ERROR_CODES.CONFLICT, field: 'status', message: 'Illegal status transition.' },
        { code: ERROR_CODES.TRIP_SCHEDULE_CONFLICT, field: 'vehicleId', message: "The trip's unit already has another trip in the new time range." },
        { code: ERROR_CODES.TRIP_SCHEDULE_CONFLICT, field: 'driverId', message: "The trip's driver already has another trip in the new time range." },
        { code: ERROR_CODES.TRIP_SCHEDULE_CONFLICT, field: 'trailerId', message: "The trip's trailer already has another trip in the new time range." },
        { code: ERROR_CODES.TRIP_NOT_EDITABLE, field: 'status', message: 'A delivered trip cannot be edited.' },
      ]),
    ],
  })
  update(@Param('id') id: string, @Body(zodBody(UpdateTripDto)) dto: UpdateTripDto) {
    return this.trips.update(id, dto);
  }

  @Delete(':id')
  @Perm('trips', 'FULL')
  @Audit({ object: 'Trip', action: 'DELETE' })
  @HttpCode(204)
  @ApiOperation({ summary: 'Hard-deletes a trip and its stops (the trip number becomes reusable). IN_PROGRESS trips cannot be deleted.' })
  // 204 has no body; the explicit `example: null` marks "empty on purpose" for the OpenAPI example gate (B-141).
  @ApiResponse({ status: 204, description: 'Deleted.', content: { 'application/json': { example: null } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Trip not found.'),
      apiError.conflict(ERROR_CODES.TRIP_IN_PROGRESS, 'This trip is in progress and cannot be deleted. Finish or cancel it first.'),
    ],
  })
  async remove(@Param('id') id: string): Promise<void> {
    await this.trips.remove(id);
  }

  @Post(':id/assign')
  @Perm('trips', 'FULL')
  @Audit({ object: 'Trip', action: 'ASSIGN' })
  @ApiOperation({ summary: 'Assigns (or reassigns) a driver/vehicle/trailer to a trip.' })
  @ApiOkResponse({ schema: { example: { id: 'trp_2', status: 'ASSIGNED', driverId: 'drv_1' } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Trip not found.'),
      withTripAssigneeConflicts(apiError.fieldConflicts([
        { code: ERROR_CODES.CONFLICT, field: 'status', message: 'Only a planned or assigned trip can be (re)assigned.' },
        { code: ERROR_CODES.TRIP_SCHEDULE_CONFLICT, field: 'vehicleId', message: "The new unit already has another trip in this trip's time range." },
        { code: ERROR_CODES.TRIP_SCHEDULE_CONFLICT, field: 'driverId', message: "The new driver already has another trip in this trip's time range." },
        { code: ERROR_CODES.TRIP_SCHEDULE_CONFLICT, field: 'trailerId', message: "The new trailer already has another trip in this trip's time range." },
      ])),
      TRIP_ASSIGNEE_NOT_FOUND,
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
