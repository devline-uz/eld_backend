import { AppException } from '../../common/errors/app.exception';
import { EventBusService } from '../../core/events/event-bus.service';
import { VehiclesRepository } from '../vehicles/vehicles.repository';
import { DefectsRepository } from './defects.repository';
import { DefectsService } from './defects.service';
import { WorkOrdersRepository } from './work-orders.repository';

/** Typed matchers — a bare `expect.any()` is `any` to the linter. */
const ANY_STRING: unknown = expect.any(String);

function makeDefect(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'def_1',
    dvirId: 'dvir_1',
    vehicleId: 'veh_1',
    severity: 'CRITICAL',
    status: 'OPEN',
    outOfService: true,
    workOrderId: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('DefectsService (TZ §5.10 out-of-service rule)', () => {
  let repo: jest.Mocked<
    Pick<DefectsRepository, 'findById' | 'update' | 'list' | 'count' | 'findByWorkOrder' | 'countOutOfServiceWorkOrders' | 'activeUserExists'>
  >;
  let vehicles: jest.Mocked<Pick<VehiclesRepository, 'findById' | 'update'>>;
  let events: jest.Mocked<Pick<EventBusService, 'publish'>>;
  let workOrders: jest.Mocked<Pick<WorkOrdersRepository, 'findById'>>;
  let service: DefectsService;

  beforeEach(() => {
    repo = {
      findById: jest.fn(),
      update: jest.fn(),
      list: jest.fn(),
      count: jest.fn(),
      findByWorkOrder: jest.fn(),
      countOutOfServiceWorkOrders: jest.fn().mockResolvedValue(0),
      activeUserExists: jest.fn().mockResolvedValue(true),
    };
    vehicles = { findById: jest.fn(), update: jest.fn() };
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    workOrders = { findById: jest.fn() };
    service = new DefectsService(
      repo as unknown as DefectsRepository,
      vehicles as unknown as VehiclesRepository,
      events as unknown as EventBusService,
      workOrders as unknown as WorkOrdersRepository,
    );
  });

  describe('CODE-077 — resolve carries the work-order link in the same write', () => {
    const openWo = { id: '11111111-1111-4111-8111-111111111111', vehicleId: 'veh_1', status: 'OPEN' };

    it('links and resolves in ONE update', async () => {
      const defect = makeDefect({ outOfService: false, severity: 'MINOR' });
      repo.findById.mockResolvedValue(defect as never);
      workOrders.findById.mockResolvedValue(openWo as never);
      repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);

      await service.resolve('def_1', { resolutionType: 'REPAIRED', workOrderId: openWo.id }, 'user_1');

      expect(repo.update).toHaveBeenCalledTimes(1);
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'def_1' },
        expect.objectContaining({ status: 'REPAIRED', workOrder: { connect: { id: openWo.id } } }),
      );
    });

    it('writes nothing when the link is refused (work order on another unit)', async () => {
      repo.findById.mockResolvedValue(makeDefect() as never);
      workOrders.findById.mockResolvedValue({ ...openWo, vehicleId: 'veh_2' } as never);
      await expect(service.resolve('def_1', { resolutionType: 'REPAIRED', workOrderId: openWo.id }, 'user_1')).rejects.toBeInstanceOf(
        AppException,
      );
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('leaves the link alone when workOrderId is omitted', async () => {
      const defect = makeDefect({ outOfService: false, severity: 'MINOR', workOrderId: openWo.id });
      repo.findById.mockResolvedValue(defect as never);
      repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);
      await service.resolve('def_1', { resolutionType: 'REPAIRED' }, 'user_1');
      expect(repo.update.mock.calls[0][1]).not.toHaveProperty('workOrder');
    });
  });

  it('CODE-076 — assigning a defect to an unknown or inactive user is a 422', async () => {
    repo.findById.mockResolvedValue(makeDefect() as never);
    repo.activeUserExists.mockResolvedValue(false);
    await expect(service.assign('def_1', { assigneeId: '22222222-2222-4222-8222-222222222222' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(repo.update).not.toHaveBeenCalled();
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

  it('QA CODE-034 — refuses to resolve an already REPAIRED defect again (409, nothing written)', async () => {
    const defect = makeDefect({ status: 'REPAIRED' });
    repo.findById.mockResolvedValue(defect as never);

    await expect(service.resolve('def_1', { resolutionType: 'REPAIRED' }, 'user_1')).rejects.toMatchObject({ status: 409 });

    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.count).not.toHaveBeenCalled();
    expect(vehicles.update).not.toHaveBeenCalled();
  });

  it('QA CODE-034 — a DEFERRED defect can still be repaired later', async () => {
    const defect = makeDefect({ status: 'DEFERRED' });
    repo.findById.mockResolvedValue(defect as never);
    repo.update.mockResolvedValue({ ...defect, status: 'REPAIRED' } as never);

    await service.resolve('def_1', { resolutionType: 'REPAIRED' }, 'user_1');

    expect(repo.update).toHaveBeenCalledWith({ id: 'def_1' }, expect.objectContaining({ status: 'REPAIRED' }));
  });

  it.each([
    ['in the future', () => new Date(Date.now() + 60 * 60_000).toISOString()],
    ['before the defect was reported', () => '2026-08-31T23:00:00.000Z'],
  ])('QA CODE-034 — rejects completedAt %s (422 on completedAt)', async (_label, at) => {
    repo.findById.mockResolvedValue(makeDefect({ severity: 'MAJOR' }) as never);

    await expect(service.resolve('def_1', { resolutionType: 'REPAIRED', completedAt: at() }, 'user_1')).rejects.toMatchObject({
      status: 422,
      details: { completedAt: ANY_STRING },
    });
    expect(repo.update).not.toHaveBeenCalled();
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
      expect.objectContaining({ correctedBy: 'Joe Mechanic', laborHours: 2.5, partsCostUsd: 120, completedAt: new Date('2026-09-20T10:00:00.000Z') }),
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

  describe('linkWorkOrder (QA CODE-032)', () => {
    const openWo = { id: 'wo_1', vehicleId: 'veh_1', status: 'OPEN' };

    it('links an open defect to an open work order of the same unit', async () => {
      repo.findById.mockResolvedValue(makeDefect() as never);
      workOrders.findById.mockResolvedValue(openWo as never);
      repo.update.mockResolvedValue(makeDefect({ workOrderId: 'wo_1' }) as never);

      await service.linkWorkOrder('def_1', { workOrderId: 'wo_1' });

      expect(repo.update).toHaveBeenCalledWith({ id: 'def_1' }, { workOrder: { connect: { id: 'wo_1' } } });
    });

    it('404s (not 500) on an unknown work order id', async () => {
      repo.findById.mockResolvedValue(makeDefect() as never);
      workOrders.findById.mockResolvedValue(null);

      await expect(service.linkWorkOrder('def_1', { workOrderId: 'wo_x' })).rejects.toMatchObject({ status: 404, code: 'WORK_ORDER_NOT_FOUND' });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it.each([
      ['a work order of another unit', makeDefect(), { ...openWo, vehicleId: 'veh_2' }, 422],
      ['a DONE work order', makeDefect(), { ...openWo, status: 'DONE' }, 409],
      ['a REPAIRED defect', makeDefect({ status: 'REPAIRED' }), openWo, 409],
    ])('refuses %s', async (_label, defect, workOrder, status) => {
      repo.findById.mockResolvedValue(defect as never);
      workOrders.findById.mockResolvedValue(workOrder as never);

      await expect(service.linkWorkOrder('def_1', { workOrderId: 'wo_1' })).rejects.toMatchObject({ status });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('does not move a defect off a signed-off work order', async () => {
      repo.findById.mockResolvedValue(makeDefect({ workOrderId: 'wo_done' }) as never);
      workOrders.findById.mockResolvedValue({ id: 'wo_done', vehicleId: 'veh_1', status: 'DONE' } as never);

      await expect(service.linkWorkOrder('def_1', { workOrderId: null })).rejects.toMatchObject({ status: 409, code: 'WORK_ORDER_CLOSED' });
      expect(repo.update).not.toHaveBeenCalled();
    });
  });
});
