import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { ApiStandardErrors } from '../../common/errors';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import { MobileBootstrapResponse } from './dto/mobile.responses';
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
  @ApiEnvelopeResponse(MobileBootstrapResponse, {
    description: '`inspectionPacket.days[]` has the `GET /mobile/logs` day shape (8 days, oldest first; shown empty here for brevity).',
    example: {
      serverTime: '2026-10-08T15:41:00.000Z',
      hosEngineVersion: '1.0.3',
      driver: {
        id: 'drv_1', username: 'johnsmith', firstName: 'John', lastName: 'Smith', cdlNumber: 'W8569238', cdlState: 'KY',
        email: 'john@example.com', phone: '+15025550100', exemptDriverStatus: false, status: 'ACTIVE',
        homeTerminalName: 'Columbus Terminal', homeTerminalTimezone: 'America/New_York', hosRuleset: 'US_70_8_PROPERTY',
        exceptions: { allowPersonalConveyance: true, allowYardMove: true, adverseDrivingEnabled: false, shortHaulException: false, splitSleeperEnabled: true, eldExempt: false, eldExemptReason: null },
        lastSyncAt: '2026-10-08T15:30:00.000Z',
      },
      vehicle: { id: 'veh_1', unitNumber: '4821', vin: '1FUJA6CV71LM12345', make: 'Freightliner', model: 'Cascadia', year: 2021, sleeperBerth: true, status: 'ACTIVE', odometerMi: 84213 },
      device: { id: 'dev_1', serial: 'PT30-001', model: 'PT30', firmware: '2.4.1', status: 'ASSIGNED', bleState: 'CONNECTED', bleMacAddress: 'A4:C1:38:5E:A8:6E', pairedAt: '2026-09-01T12:00:00.000Z', periodicConnectedSec: 30, periodicDisconnectedMin: 30 },
      coDriver: null,
      availableVehicles: [{ id: 'veh_2', unitNumber: '104', make: 'Volvo', model: 'VNL', deviceSerial: null }],
      carrier: {
        name: 'Acme Freight', dotNumber: '1234567', timezone: 'America/New_York', hosRuleset: 'US_70_8_PROPERTY', distanceUnit: 'MILES',
        allowPersonalConveyance: true, allowYardMove: true, eldIdentifier: 'OBK001', mainOfficeAddress: '1 Main St, Columbus, OH 43004',
        eldProvider: 'OneBook ELD', eldRegistrationId: 'AB12', erodsMode: 'TEST',
      },
      hos: {
        computedAt: '2026-10-08T15:41:00.000Z',
        timezone: 'America/New_York',
        state: {
          currentStatus: 'ON', driveRemainingSec: 39600, shiftRemainingSec: 48600, breakRemainingSec: 28800, cycleRemainingSec: 230400,
          dailyTotals: { off: 50400, sb: 0, drive: 0, on: 1860 },
          violations: [],
          statusSince: '2026-10-08T15:10:00.000Z', nextBreakDueAt: null, shiftEndsAt: '2026-10-09T05:10:00.000Z', cycleRecapAt: null, restartAvailableAt: null,
        },
      },
      inspectionPacket: { driverId: 'drv_1', timezone: 'America/New_York', generatedAt: '2026-10-08T15:41:00.000Z', days: [] },
      syncConfig: { batchMaxChanges: 500, batchMaxBytes: 1048576, onlineIntervalSec: 60, onlineBatchThreshold: 50, offlineBackoffSec: [30, 60, 300, 900, 1800], localEventRetentionDays: 30, localInspectionRetentionDays: 8, syncBacklogWarnDays: 30, syncBacklogWarnBytes: 209715200 },
      appUpdate: null,
    },
  })
  @ApiStandardErrors()
  get(@CurrentUser('id') driverId: string) {
    return this.bootstrap.bootstrap(driverId);
  }
}
