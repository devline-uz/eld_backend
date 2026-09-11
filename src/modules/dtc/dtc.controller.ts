import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { VehiclesRepository } from '../vehicles/vehicles.repository';
import { AppException } from '../../common/errors/app.exception';
import { DtcListQueryDto } from './dto/dtc.dto';
import { DtcService } from './dtc.service';

/** TZ §5.7 — DTC surfaced on the "DVIR & Maintenance" screen (diagnostics captured from the
 * ingest/telemetry path, TZ §7.5). */
@FigmaScreen('web/dvir-maintenance')
@ApiTags('dtc')
@ApiBearerAuth()
@Controller('vehicles/:id/dtc')
export class DtcController {
  constructor(private readonly dtc: DtcService, private readonly vehicles: VehiclesRepository) {}

  @Get()
  @Perm('maintenance', 'READ')
  @ApiQuery({ name: 'includeCleared', required: false })
  @ApiOperation({ summary: 'Lists DTCs (J1939 SPN/FMI) captured for a unit; open codes by default (TZ §5.7).' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'dtc_1', vehicleId: 'veh_1', spn: 100, fmi: 1, occurrence: 3, source: '0', description: null, firstSeenAt: '2026-09-10T12:00:00.000Z', lastSeenAt: '2026-09-11T08:00:00.000Z', clearedAt: null }] } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.')] })
  async list(@Param('id') vehicleId: string, @Query(zodBody(DtcListQueryDto)) query: DtcListQueryDto) {
    const vehicle = await this.vehicles.findById({ id: vehicleId });
    if (!vehicle) throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404, { vehicleId });
    const items = await this.dtc.list(vehicleId, query.includeCleared ?? false);
    return { items };
  }
}
