import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { CoDriverPairingsService } from './co-driver-pairings.service';
import { CoDriverPairingListQueryDto, CreateCoDriverPairingDto } from './dto/co-driver-pairings.dto';

/** §20 B-7 — team-driving co-driver pairing, surfaced on W-04 Unit profile / W-07 (TZ §5.3). */
@FigmaScreen('web/vehicle-add', 'web/drivers')
@ApiTags('co-driver-pairings')
@ApiBearerAuth()
@Controller('co-driver-pairings')
export class CoDriverPairingsController {
  constructor(private readonly pairings: CoDriverPairingsService) {}

  @Get()
  @Perm('drivers', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'vehicleId', required: false })
  @ApiQuery({ name: 'driverId', required: false })
  @ApiQuery({ name: 'active', required: false, enum: ['true', 'false'] })
  @ApiOperation({ summary: 'Lists co-driver pairings (team driving), optionally scoped to a unit or driver, active-only.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'pair_1', primaryDriverId: 'drv_1', coDriverId: 'drv_2', vehicleId: 'veh_1', startedAt: '2026-09-24T00:00:00.000Z', endedAt: null }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  list(@Query(zodBody(CoDriverPairingListQueryDto)) query: CoDriverPairingListQueryDto) {
    return this.pairings.list(query);
  }

  @Post()
  @Perm('drivers', 'FULL')
  @Audit({ object: 'CoDriverPairing', action: 'CREATE' })
  @ApiOperation({ summary: 'Starts a co-driver pairing on a unit (team driving, TZ §5.3 hard rule — never a plain Driver column).' })
  @ApiCreatedResponse({ schema: { example: { id: 'pair_1', primaryDriverId: 'drv_1', coDriverId: 'drv_2', vehicleId: 'veh_1', startedAt: '2026-09-24T00:00:00.000Z', endedAt: null } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.'), apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.'), apiError.conflict(ERROR_CODES.CONFLICT, 'This co-driver already has an active pairing on this unit.')] })
  create(@Body(zodBody(CreateCoDriverPairingDto)) dto: CreateCoDriverPairingDto, @CurrentUser('id') actorId?: string) {
    return this.pairings.create(dto, actorId);
  }

  @Post(':id/end')
  @Perm('drivers', 'FULL')
  @Audit({ object: 'CoDriverPairing', action: 'END' })
  @ApiOperation({ summary: 'Ends an active co-driver pairing.' })
  @ApiCreatedResponse({ schema: { example: { id: 'pair_1', endedAt: '2026-09-24T12:00:00.000Z' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.CO_DRIVER_PAIRING_NOT_FOUND, 'Co-driver pairing not found.')] })
  end(@Param('id') id: string, @CurrentUser('id') actorId?: string) {
    return this.pairings.end(id, actorId);
  }
}
