import { AppException } from '../../common/errors/app.exception';
import { DeviceHealthRepository } from './device-health.repository';
import { DeviceHealthService } from './device-health.service';
import { MobileRepository } from './mobile.repository';

const DRIVER = { id: 'drv_1', assignedVehicleId: 'veh_1' };

function build() {
  const repo = { findDriver: jest.fn().mockResolvedValue(DRIVER) };
  const health = {
    findDeviceByVehicle: jest.fn().mockResolvedValue({ id: 'dev_1', serial: 'PT30-001', firmware: '2.4.1', bleState: 'CONNECTED', storedEventsCount: 3, lastSeenAt: null }),
    findMalfunctionEvents: jest.fn().mockResolvedValue([]),
    findPendingUnidentifiedSegments: jest.fn().mockResolvedValue([]),
    findHosSnapshot: jest.fn().mockResolvedValue(null),
  };
  const service = new DeviceHealthService(repo as unknown as MobileRepository, health as unknown as DeviceHealthRepository);
  return { repo, health, service };
}

describe('DeviceHealthService', () => {
  it('404s when the driver does not exist', async () => {
    const { repo, service } = build();
    repo.findDriver.mockResolvedValue(null);
    await expect(service.get('nope')).rejects.toBeInstanceOf(AppException);
  });

  it('folds eventType 7 logged/cleared pairs into only-still-active codes', async () => {
    const { health, service } = build();
    health.findMalfunctionEvents.mockResolvedValue([
      { eventCode: 1, malfunctionCode: 'P', diagnosticCode: null },
      { eventCode: 3, malfunctionCode: null, diagnosticCode: '5' },
      { eventCode: 1, malfunctionCode: 'E', diagnosticCode: null },
      { eventCode: 2, malfunctionCode: 'E', diagnosticCode: null },
    ]);
    const result = await service.get('drv_1');
    expect(result.activeCodes).toEqual(
      expect.arrayContaining([{ kind: 'malfunction', code: 'P' }, { kind: 'diagnostic', code: '5' }]),
    );
    expect(result.activeCodes).not.toEqual(expect.arrayContaining([{ kind: 'malfunction', code: 'E' }]));
  });

  it('reports pending unidentified segments on the vehicle as confirmation request ids', async () => {
    const { health, service } = build();
    health.findPendingUnidentifiedSegments.mockResolvedValue([{ id: 'seg_1' }, { id: 'seg_2' }]);
    const result = await service.get('drv_1');
    expect(result.unidentified.pendingCount).toBe(2);
    expect(result.unidentified.pendingConfirmationRequestIds).toEqual(['seg_1', 'seg_2']);
  });

  it('surfaces the last HOS drift snapshot when present', async () => {
    const { health, service } = build();
    health.findHosSnapshot.mockResolvedValue({ computedAt: new Date(0), lastComparedAt: new Date(0), maxDriftSec: 90, driftAlerted: true });
    const result = await service.get('drv_1');
    expect(result.hosDrift).toEqual({ computedAt: new Date(0), lastComparedAt: new Date(0), maxDriftSec: 90, driftAlerted: true });
  });

  it('returns a null device/vehicle shape when the driver has no assigned vehicle', async () => {
    const { repo, health, service } = build();
    repo.findDriver.mockResolvedValue({ id: 'drv_1', assignedVehicleId: null });
    const result = await service.get('drv_1');
    expect(result.vehicleId).toBeNull();
    expect(result.device).toBeNull();
    expect(health.findDeviceByVehicle).not.toHaveBeenCalled();
  });

  it('queries pending unidentified segments by driverId even without an assigned vehicle (§20 B-83)', async () => {
    const { repo, health, service } = build();
    repo.findDriver.mockResolvedValue({ id: 'drv_1', assignedVehicleId: null });
    await service.get('drv_1');
    expect(health.findPendingUnidentifiedSegments).toHaveBeenCalledWith(null, 'drv_1', expect.any(Date));
  });

  it('includes a PENDING_CONFIRMATION segment addressed to this driver in the request ids', async () => {
    const { health, service } = build();
    health.findPendingUnidentifiedSegments.mockResolvedValue([{ id: 'seg_pc' }]);
    const result = await service.get('drv_1');
    expect(result.unidentified.pendingConfirmationRequestIds).toEqual(['seg_pc']);
    expect(health.findPendingUnidentifiedSegments).toHaveBeenCalledWith('veh_1', 'drv_1', expect.any(Date));
  });
});
