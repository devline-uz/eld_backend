import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { ApiStandardErrors } from '../../common/errors';
import { DeviceHealthService } from './device-health.service';

/**
 * TZ §7.7 / §7.8 / §5.9 / §8.6 point 5 — MB-7. Screens M-20/P-12 (device health / diagnostics).
 * Read-only, driver token only.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile')
export class DeviceHealthController {
  constructor(private readonly service: DeviceHealthService) {}

  @Get('device-health')
  @ApiOperation({
    summary: 'Active malfunction/diagnostic codes, device status, pending unidentified segments and last HOS drift for the driver\'s assigned vehicle (M-20/P-12).',
  })
  @ApiOkResponse({
    schema: {
      example: {
        vehicleId: 'veh_1',
        device: { id: 'dev_1', serial: 'PT30-001', firmware: '2.4.1', bleState: 'CONNECTED', storedEventsCount: 12 },
        activeCodes: [{ kind: 'malfunction', code: 'P' }],
        unidentified: { windowDays: 8, pendingCount: 1, pendingConfirmationRequestIds: ['seg_1'] },
        hosDrift: { computedAt: '2026-09-21T00:00:00.000Z', maxDriftSec: 4, driftAlerted: false },
      },
    },
  })
  @ApiStandardErrors()
  get(@CurrentUser('id') driverId: string) {
    return this.service.get(driverId);
  }
}
