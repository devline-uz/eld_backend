import { AppException } from '../../common/errors/app.exception';
import { EventBusService } from '../../core/events/event-bus.service';
import { VehiclesRepository } from '../vehicles/vehicles.repository';
import { DefectsRepository } from './defects.repository';
import { DefectsService } from './defects.service';

function makeDefect(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'def_1',
    dvirId: 'dvir_1',
    vehicleId: 'veh_1',
    severity: 'CRITICAL',
    status: 'OPEN',
    outOfService: true,
    ...overrides,
  };
}

describe('DefectsService (TZ §5.10 out-of-service rule)', () => {
  let repo: jest.Mocked<Pick<DefectsRepository, 'findById' | 'update' | 'list' | 'count' | 'findByWorkOrder'>>;
  let vehicles: jest.Mocked<Pick<VehiclesRepository, 'findById' | 'update'>>;
  let events: jest.Mocked<Pick<EventBusService, 'publish'>>;
  let service: DefectsService;

  beforeEach(() => {
    repo = { findById: jest.fn(), update: jest.fn(), list: jest.fn(), count: jest.fn(), findByWorkOrder: jest.fn() };
    vehicles = { findById: jest.fn(), update: jest.fn() };
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new DefectsService(repo as unknown as DefectsRepository, vehicles as unknown as VehiclesRepository, events as unknown as EventBusService);
  });

  it('404s resolving a defect that does not exist', async () => {
    repo.findById.mockResolvedValue(null as never);
    await expect(service.resolve('missing', { status: 'REPAIRED' }, 'user_1')).rejects.toBeInstanceOf(AppException);
  });

  it('restores the vehicle from OUT_OF_SERVICE when the last open CRITICAL defect is resolved', async () => {
    const defect = makeDefect();
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);
    repo.count.mockResolvedValue(0); // no other open CRITICAL defects left
    vehicles.findById.mockResolvedValue({ id: 'veh_1', status: 'OUT_OF_SERVICE' } as never);

    await service.resolve('def_1', { status: 'REPAIRED', resolutionNote: 'Brakes replaced' }, 'user_1');

    expect(vehicles.update).toHaveBeenCalledWith({ id: 'veh_1' }, { status: 'ACTIVE' });
    expect(events.publish).toHaveBeenCalledWith('vehicle.restored_from_out_of_service', { vehicleId: 'veh_1' });
  });

  it('does NOT restore the vehicle while another open CRITICAL defect remains', async () => {
    const defect = makeDefect();
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);
    repo.count.mockResolvedValue(1); // one other open CRITICAL defect

    await service.resolve('def_1', { status: 'REPAIRED' }, 'user_1');

    expect(vehicles.update).not.toHaveBeenCalled();
  });

  it('does NOT restore a vehicle that is not currently OUT_OF_SERVICE (never overrides an unrelated manual state)', async () => {
    const defect = makeDefect();
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);
    repo.count.mockResolvedValue(0);
    vehicles.findById.mockResolvedValue({ id: 'veh_1', status: 'INACTIVE' } as never);

    await service.resolve('def_1', { status: 'REPAIRED' }, 'user_1');

    expect(vehicles.update).not.toHaveBeenCalled();
  });

  it('does not touch the vehicle when resolving a MINOR defect', async () => {
    const defect = makeDefect({ severity: 'MINOR', outOfService: false });
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);

    await service.resolve('def_1', { status: 'REPAIRED' }, 'user_1');

    expect(repo.count).not.toHaveBeenCalled();
    expect(vehicles.update).not.toHaveBeenCalled();
  });
});
