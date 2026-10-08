import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { ApiStandardErrors } from '../../common/errors';
import { MobileBootstrapService } from './mobile-bootstrap.service';

/**
 * TZ §11.8 / §13.2 — `GET /mobile/bootstrap`. Driver token only: the app calls this once on
 * cold start and after every reconnect to refresh everything it needs to run fully offline
 * until the next call (§8.6 point 4, §13.5).
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile')
export class MobileBootstrapController {
  constructor(private readonly bootstrap: MobileBootstrapService) {}

  @Get('bootstrap')
  @ApiOperation({
    summary:
      'Driver/vehicle/device/carrier context, current HOS state, the engine version, server time and the offline DOT-inspection packet (§8.6, §13.2, §13.5).',
  })
  @ApiOkResponse({
    schema: {
      example: {
        serverTime: '2026-09-11T15:41:00.000Z',
        hosEngineVersion: '1.0.1',
        driver: { id: 'drv_1', username: 'johnsmith', firstName: 'John', lastName: 'Smith', cdlNumber: 'W8569238', cdlState: 'KY', email: 'john@example.com', phone: '+15025550100', exemptDriverStatus: false },
        carrier: { name: 'Acme Freight', dotNumber: '1234567', mainOfficeAddress: '1 Main St, Columbus, OH 43004', eldProvider: 'OneBook ELD', eldIdentifier: 'OBK001', eldRegistrationId: 'AB12' },
        vehicle: { id: 'veh_1', unitNumber: '4821' },
        device: { id: 'dev_1', serial: 'PT30-001', bleState: 'CONNECTED' },
        // MR-24 — `hos.state` also carries statusSince / nextBreakDueAt / shiftEndsAt /
        // cycleRecapAt / restartAvailableAt (ISO-8601 or null), same shape as hos-state `serverState`.
        hos: {
          computedAt: '2026-09-11T15:41:00.000Z',
          timezone: 'America/Chicago',
          state: {
            currentStatus: 'ON',
            driveRemainingSec: 39600,
            statusSince: '2026-09-11T15:10:00.000Z',
            nextBreakDueAt: null,
            shiftEndsAt: '2026-09-12T05:10:00.000Z',
            cycleRecapAt: null,
            restartAvailableAt: null,
          },
        },
        inspectionPacket: { days: [] },
        syncConfig: { batchMaxChanges: 500, batchMaxBytes: 1048576 },
      },
    },
  })
  @ApiStandardErrors()
  get(@CurrentUser('id') driverId: string) {
    return this.bootstrap.bootstrap(driverId);
  }
}
