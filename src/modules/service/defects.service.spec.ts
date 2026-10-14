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
  let repo: jest.Mocked<Pick<DefectsRepository, 'findById' | 'update' | 'list' | 'count' | 'findByWorkOrder' | 'countOutOfServiceWorkOrders'>>;
  let vehicles: jest.Mocked<Pick<VehiclesRepository, 'findById' | 'update'>>;
  let events: jest.Mocked<Pick<EventBusService, 'publish'>>;
  let service: DefectsService;

  beforeEach(() => {
    repo = {
      findById: jest.fn(),
      update: jest.fn(),
      list: jest.fn(),
      count: jest.fn(),
      findByWorkOrder: jest.fn(),
      countOutOfServiceWorkOrders: jest.fn().mockResolvedValue(0),
    };
    vehicles = { findById: jest.fn(), update: jest.fn() };
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new DefectsService(repo as unknown as DefectsRepository, vehicles as unknown as VehiclesRepository, events as unknown as EventBusService);
  });

  it('404s resolving a defect that does not exist', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.resolve('missing', { resolutionType: 'REPAIRED' }, 'user_1')).rejects.toBeInstanceOf(AppException);
  });

  it('restores the vehicle from OUT_OF_SERVICE when the last open CRITICAL defect is resolved', async () => {
    const defect = makeDefect();
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);
    repo.count.mockResolvedValue(0); // no other open CRITICAL defects left
    vehicles.findById.mockResolvedValue({ id: 'veh_1', status: 'OUT_OF_SERVICE' } as never);

    await service.resolve('def_1', { resolutionType: 'REPAIRED', resolutionNote: 'Brakes replaced' }, 'user_1');

    expect(vehicles.update).toHaveBeenCalledWith({ id: 'veh_1' }, { status: 'ACTIVE' });
    expect(events.publish).toHaveBeenCalledWith('vehicle.restored_from_out_of_service', { vehicleId: 'veh_1' });
  });

  it('does NOT restore the vehicle while an open work order still keeps it out of service', async () => {
    const defect = makeDefect();
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);
    repo.count.mockResolvedValue(0);
    repo.countOutOfServiceWorkOrders.mockResolvedValue(1);
    vehicles.findById.mockResolvedValue({ id: 'veh_1', status: 'OUT_OF_SERVICE' } as never);

    await service.resolve('def_1', { resolutionType: 'REPAIRED' }, 'user_1');

    expect(repo.countOutOfServiceWorkOrders).toHaveBeenCalledWith('veh_1');
    expect(vehicles.update).not.toHaveBeenCalled();
  });

  it('does NOT restore the vehicle while another open CRITICAL defect remains', async () => {
    const defect = makeDefect();
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);
    repo.count.mockResolvedValue(1); // one other open CRITICAL defect

    await service.resolve('def_1', { resolutionType: 'REPAIRED' }, 'user_1');

    expect(vehicles.update).not.toHaveBeenCalled();
  });

  it('does NOT restore a vehicle that is not currently OUT_OF_SERVICE (never overrides an unrelated manual state)', async () => {
    const defect = makeDefect();
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);
    repo.count.mockResolvedValue(0);
    vehicles.findById.mockResolvedValue({ id: 'veh_1', status: 'INACTIVE' } as never);

    await service.resolve('def_1', { resolutionType: 'REPAIRED' }, 'user_1');

    expect(vehicles.update).not.toHaveBeenCalled();
  });

  it('QA CODE-008 — deferring a CRITICAL defect keeps the unit OUT_OF_SERVICE (no restore, no count)', async () => {
    const defect = makeDefect();
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'DEFERRED', resolutionType: 'DEFERRED' } as never);
    repo.count.mockResolvedValue(0);
    vehicles.findById.mockResolvedValue({ id: 'veh_1', status: 'OUT_OF_SERVICE' } as never);

    await service.resolve('def_1', { resolutionType: 'DEFERRED', resolutionNote: 'Parts on order' }, 'user_1');

    expect(repo.update).toHaveBeenCalledWith({ id: 'def_1' }, expect.objectContaining({ status: 'DEFERRED', resolutionType: 'DEFERRED' }));
    expect(vehicles.update).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalledWith('vehicle.restored_from_out_of_service', expect.anything());
    expect(events.publish).toHaveBeenCalledWith('defect.resolved', { defectId: 'def_1', vehicleId: 'veh_1', resolutionType: 'DEFERRED' });
  });

  it('QA CODE-008 — repairing a previously DEFERRED CRITICAL defect restores the unit once nothing else holds it', async () => {
    const defect = makeDefect({ status: 'DEFERRED' });
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);
    repo.count.mockResolvedValue(0);
    vehicles.findById.mockResolvedValue({ id: 'veh_1', status: 'OUT_OF_SERVICE' } as never);

    await service.resolve('def_1', { resolutionType: 'REPAIRED' }, 'user_1');

    expect(vehicles.update).toHaveBeenCalledWith({ id: 'veh_1' }, { status: 'ACTIVE' });
  });

  it('QA CODE-008 — repairing an IN_PROGRESS CRITICAL defect also restores the unit', async () => {
    const defect = makeDefect({ status: 'IN_PROGRESS' });
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);
    repo.count.mockResolvedValue(0);
    vehicles.findById.mockResolvedValue({ id: 'veh_1', status: 'OUT_OF_SERVICE' } as never);

    await service.resolve('def_1', { resolutionType: 'NOT_REQUIRED' }, 'user_1');

    expect(vehicles.update).toHaveBeenCalledWith({ id: 'veh_1' }, { status: 'ACTIVE' });
  });

  it('QA CODE-008 — a remaining DEFERRED critical defect counts as a hold (open / in-progress / deferred are all counted)', async () => {
    const defect = makeDefect();
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);
    repo.count.mockResolvedValue(1); // another critical defect, deferred
    vehicles.findById.mockResolvedValue({ id: 'veh_1', status: 'OUT_OF_SERVICE' } as never);

    await service.resolve('def_1', { resolutionType: 'REPAIRED' }, 'user_1');

    expect(repo.count).toHaveBeenCalledWith({
      vehicleId: 'veh_1',
      status: { in: ['OPEN', 'IN_PROGRESS', 'DEFERRED'] },
      OR: [{ severity: 'CRITICAL' }, { outOfService: true }],
    });
    expect(vehicles.update).not.toHaveBeenCalled();
  });

  it('does not re-run the restore when an already REPAIRED critical defect is edited again', async () => {
    const defect = makeDefect({ status: 'REPAIRED' });
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue(defect as never);

    await service.resolve('def_1', { resolutionType: 'REPAIRED' }, 'user_1');

    expect(repo.count).not.toHaveBeenCalled();
    expect(vehicles.update).not.toHaveBeenCalled();
  });

  it('does not touch the vehicle when resolving a MINOR defect', async () => {
    const defect = makeDefect({ severity: 'MINOR', outOfService: false });
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);

    await service.resolve('def_1', { resolutionType: 'REPAIRED' }, 'user_1');

    expect(repo.count).not.toHaveBeenCalled();
    expect(vehicles.update).not.toHaveBeenCalled();
  });

  it('B-68 — NOT_REQUIRED is written as resolutionType, never as a REPAIRED status (§396.11 record must not read as a repair)', async () => {
    const defect = makeDefect({ severity: 'MAJOR' });
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED', resolutionType: 'NOT_REQUIRED' } as never);

    await service.resolve('def_1', { resolutionType: 'NOT_REQUIRED' }, 'user_1');

    expect(repo.update).toHaveBeenCalledWith(
      { id: 'def_1' },
      expect.objectContaining({ resolutionType: 'NOT_REQUIRED' }),
    );
  });

  it('B-70 — persists correctedBy/completedAt/laborHours/partsCostUsd on resolve', async () => {
    const defect = makeDefect({ severity: 'MAJOR' });
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);

    await service.resolve(
      'def_1',
      { resolutionType: 'REPAIRED', correctedBy: 'Joe Mechanic', completedAt: '2026-09-20T10:00:00.000Z', laborHours: 2.5, partsCostUsd: 120 },
      'user_1',
    );

    expect(repo.update).toHaveBeenCalledWith(
      { id: 'def_1' },
      expect.objectContaining({ correctedBy: 'Joe Mechanic', laborHours: 2.5, partsCostUsd: 120 }),
    );
  });

  it('B-40 — assign() sets the assigneeId', async () => {
    repo.findById.mockResolvedValue(makeDefect() as never);
    repo.update.mockResolvedValue(makeDefect({ assigneeId: 'usr_2' }) as never);

    await service.assign('def_1', { assigneeId: 'usr_2' });

    expect(repo.update).toHaveBeenCalledWith({ id: 'def_1' }, { assigneeId: 'usr_2' });
  });

  it('B-40 — assign() clears the assigneeId with null', async () => {
    repo.findById.mockResolvedValue(makeDefect({ assigneeId: 'usr_2' }) as never);
    repo.update.mockResolvedValue(makeDefect({ assigneeId: null }) as never);

    await service.assign('def_1', { assigneeId: null });

    expect(repo.update).toHaveBeenCalledWith({ id: 'def_1' }, { assigneeId: null });
  });
});
