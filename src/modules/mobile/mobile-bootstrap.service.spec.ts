/** MB-19 — `bootstrap.appUpdate` sourced from env via `AppConfigService`. */
import type { AppConfigService } from '../../core/config/config.service';
import type { HosRecalcService } from '../hos-recalc/hos-recalc.service';
import type { LogsService } from '../logs/logs.service';
import { MobileBootstrapService } from './mobile-bootstrap.service';
import type { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';
import type { MobileRepository } from './mobile.repository';

const DRIVER = {
  id: 'drv_1',
  firstName: 'A',
  lastName: 'B',
  cdlNumber: 'X',
  cdlState: 'KY',
  status: 'ACTIVE',
  homeTerminalName: 'HQ',
  homeTerminalTimezone: 'America/New_York',
  hosRuleset: 'US_70_8_PROPERTY',
  allowPersonalConveyance: false,
  allowYardMove: false,
  adverseDrivingEnabled: false,
  shortHaulException: false,
  splitSleeperEnabled: false,
  eldExempt: false,
  eldExemptReason: null,
  lastSyncAt: null,
  assignedVehicleId: null,
};

function build(env: Record<string, string | undefined>) {
  const repo = {
    findDriver: jest.fn().mockResolvedValue(DRIVER),
    findCarrier: jest.fn().mockResolvedValue(null),
    findVehicle: jest.fn(),
    findActivePairing: jest.fn().mockResolvedValue(null),
    findDeviceByVehicle: jest.fn(),
  };
  const hosRecalc = { computeCurrentState: jest.fn().mockResolvedValue(null) };
  const logs = { getInspectionPacket: jest.fn().mockResolvedValue({ days: [] }) };
  const config = { get: jest.fn((key: string) => env[key]) };
  const fleetOps = {
    findAvailableVehicles: jest.fn().mockResolvedValue([]),
    findLatestDutyStatus: jest.fn().mockResolvedValue(null),
  };
  const service = new MobileBootstrapService(
    repo as unknown as MobileRepository,
    hosRecalc as unknown as HosRecalcService,
    logs as unknown as LogsService,
    config as unknown as AppConfigService,
    fleetOps as unknown as MobileFleetOpsRepository,
  );
  return service;
}

describe('MobileBootstrapService — appUpdate (MB-19)', () => {
  it('is null when nothing is configured', async () => {
    const service = build({});
    const result = await service.bootstrap('drv_1');
    expect(result.appUpdate).toBeNull();
  });

  it('reads every field from env when configured', async () => {
    const service = build({
      MOBILE_APP_LATEST_VERSION: '2.3.0',
      MOBILE_APP_MIN_VERSION: '2.0.0',
      MOBILE_APP_RELEASE_NOTES: 'Bug fixes',
      MOBILE_APP_STORE_URL_IOS: 'https://apps.apple.com/app/x',
      MOBILE_APP_STORE_URL_ANDROID: 'https://play.google.com/store/apps/details?id=x',
    });
    const result = await service.bootstrap('drv_1');
    expect(result.appUpdate).toEqual({
      latestVersion: '2.3.0',
      minVersion: '2.0.0',
      notes: 'Bug fixes',
      storeUrl: { ios: 'https://apps.apple.com/app/x', android: 'https://play.google.com/store/apps/details?id=x' },
    });
  });

  it('fills a missing sub-field with null instead of omitting it', async () => {
    const service = build({ MOBILE_APP_LATEST_VERSION: '2.3.0' });
    const result = await service.bootstrap('drv_1');
    expect(result.appUpdate).toEqual({
      latestVersion: '2.3.0',
      minVersion: null,
      notes: null,
      storeUrl: { ios: null, android: null },
    });
  });
});
