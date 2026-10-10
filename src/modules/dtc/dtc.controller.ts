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
  @ApiOperation({ summary: 'Lists DTCs captured for a unit — J1939 SPN/FMI, J1708 SID/PID+FMI (`code`), OBD-II `code`; open codes by default (TZ §5.7, PT SDK 6.11).' })
  @ApiOkResponse({ schema: { example: { items: [
    { id: 'dtc_1', vehicleId: 'veh_1', spn: 100, fmi: 1, code: null, bus: 'J1939', milOn: true, conversionMethod: 0, active: null, occurrence: 3, source: '0', description: null, firstSeenAt: '2026-09-10T12:00:00.000Z', lastSeenAt: '2026-09-11T08:00:00.000Z', clearedAt: null },
    { id: 'dtc_2', vehicleId: 'veh_1', spn: null, fmi: 3, code: 'SID 254', bus: 'J1708', milOn: false, conversionMethod: null, active: true, occurrence: 1, source: null, description: null, firstSeenAt: '2026-09-11T08:00:00.000Z', lastSeenAt: '2026-09-11T08:00:00.000Z', clearedAt: null },
    { id: 'dtc_3', vehicleId: 'veh_1', spn: null, fmi: null, code: 'P0301', bus: 'OBD_II', milOn: true, conversionMethod: null, active: null, occurrence: 1, source: null, description: null, firstSeenAt: '2026-09-11T08:00:00.000Z', lastSeenAt: '2026-09-11T08:00:00.000Z', clearedAt: null },
  ] } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.')] })
  async list(@Param('id') vehicleId: string, @Query(zodBody(DtcListQueryDto)) query: DtcListQueryDto) {
    const vehicle = await this.vehicles.findById({ id: vehicleId });
    if (!vehicle) throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404, { vehicleId });
    const items = await this.dtc.list(vehicleId, query.includeCleared ?? false);
    return { items };
  }
}
