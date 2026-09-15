import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Perm } from '../../common/decorators/perm.decorator';
import { ApiStandardErrors } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { LiveFleetService } from './live-fleet.service';

/**
 * web/tz.md §20 B-3 — W-01 map preview and W-02 Live Fleet. Gated by `liveFleet` (READ for
 * every role, tz.md §6.4). The fleet is single-tenant (tz.md §27.3), so the carrier scope is the
 * whole `Vehicle` table.
 */
@FigmaScreen('web/live-fleet', 'web/fleet-dashboard')
@ApiTags('live')
@ApiBearerAuth()
@Controller('live')
export class LiveFleetController {
  constructor(private readonly live: LiveFleetService) {}

  @Get('fleet')
  @Perm('liveFleet', 'READ')
  @ApiOperation({
    summary: 'Current snapshot of every unit: last known position, speed, driver, duty status, HOS clocks, ELD link.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        items: [
          {
            vehicleId: 'veh_1', unitNumber: '101', driverId: 'drv_1', driverName: 'John Smith',
            driverPhone: '+1 334 765 4888', dutyStatus: 'ON_DUTY', speedMph: 0, headingDeg: 274,
            odometerMi: 993589, lat: 38.99, lon: -84.63, locationLabel: '0.64 mi N of Florence, KY',
            lastSeenAt: '2026-09-12T15:39:00.000Z', driveRemainingSec: 0,
            shiftEndsAt: '2026-09-12T15:59:34.000Z', eldSerial: 'PT30_A86E', bleState: 'CONNECTED',
          },
        ],
        generatedAt: '2026-09-12T15:39:10.000Z',
      },
    },
  })
  @ApiStandardErrors()
  fleet() {
    return this.live.snapshot();
  }
}
