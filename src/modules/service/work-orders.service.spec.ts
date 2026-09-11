import { AppException } from '../../common/errors/app.exception';
import { EventBusService } from '../../core/events/event-bus.service';
import { VehiclesRepository } from '../vehicles/vehicles.repository';
import { DefectsRepository } from './defects.repository';
import { WorkOrdersRepository } from './work-orders.repository';
import { WorkOrdersService } from './work-orders.service';

function makeWorkOrder(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 'wo_1', number: 'WO-0001', vehicleId: 'veh_1', status: 'OPEN', priority: 'NORMAL', ...overrides };
}

describe('WorkOrdersService (TZ §5.10 — defect resolution workflow tied to a work order)', () => {
  let repo: jest.Mocked<Pick<WorkOrdersRepository, 'findById' | 'create' | 'update' | 'list' | 'nextNumber'>>;
  let defects: jest.Mocked<Pick<DefectsRepository, 'findById' | 'update' | 'findByWorkOrder'>>;
  let vehicles: jest.Mocked<Pick<VehiclesRepository, 'findById'>>;
  let events: jest.Mocked<Pick<EventBusService, 'publish'>>;
  let service: WorkOrdersService;

  beforeEach(() => {
    repo = { findById: jest.fn(), create: jest.fn(), update: jest.fn(), list: jest.fn(), nextNumber: jest.fn() };
    defects = { findById: jest.fn(), update: jest.fn(), findByWorkOrder: jest.fn() };
    vehicles = { findById: jest.fn() };
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new WorkOrdersService(
      repo as unknown as WorkOrdersRepository,
      defects as unknown as DefectsRepository,
      vehicles as unknown as VehiclesRepository,
      events as unknown as EventBusService,
    );
  });

  describe('create', () => {
    it('404s for an unknown vehicle', async () => {
      vehicles.findById.mockResolvedValue(null as never);
      await expect(service.create({ vehicleId: 'veh_x', title: 'Brake service', priority: 'NORMAL' }, 'user_1')).rejects.toBeInstanceOf(AppException);
    });

    it('assigns a sequential number and attaches given defects', async () => {
      vehicles.findById.mockResolvedValue({ id: 'veh_1' } as never);
      repo.nextNumber.mockResolvedValue('WO-0002');
      const created = makeWorkOrder({ id: 'wo_2', number: 'WO-0002' });
      repo.create.mockResolvedValue(created as never);
      repo.findById.mockResolvedValue(created as never); // attachDefect -> getOrThrow
      defects.findById.mockResolvedValue({ id: 'def_1' } as never);

      await service.create({ vehicleId: 'veh_1', title: 'Brake service', priority: 'NORMAL', defectIds: ['def_1'] }, 'user_1');

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ number: 'WO-0002', title: 'Brake service' }));
      expect(defects.update).toHaveBeenCalledWith({ id: 'def_1' }, { workOrder: { connect: { id: 'wo_2' } } });
    });
  });

  describe('close', () => {
    it('refuses to close while an attached defect is still OPEN or IN_PROGRESS', async () => {
      repo.findById.mockResolvedValue(makeWorkOrder() as never);
      defects.findByWorkOrder.mockResolvedValue([{ id: 'def_1', status: 'OPEN' }] as never);

      await expect(service.close('wo_1')).rejects.toMatchObject({ code: 'DEFECT_NOT_RESOLVED' });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('closes once every attached defect is REPAIRED/DEFERRED', async () => {
      repo.findById.mockResolvedValue(makeWorkOrder() as never);
      defects.findByWorkOrder.mockResolvedValue([{ id: 'def_1', status: 'REPAIRED' }, { id: 'def_2', status: 'DEFERRED' }] as never);
      repo.update.mockResolvedValue(makeWorkOrder({ status: 'DONE' }) as never);

      await service.close('wo_1');

      expect(repo.update).toHaveBeenCalledWith({ id: 'wo_1' }, expect.objectContaining({ status: 'DONE' }));
      expect(events.publish).toHaveBeenCalledWith('work_order.closed', { workOrderId: 'wo_1', vehicleId: 'veh_1' });
    });

    it('refuses to close a work order that is already DONE/CANCELLED', async () => {
      repo.findById.mockResolvedValue(makeWorkOrder({ status: 'DONE' }) as never);
      await expect(service.close('wo_1')).rejects.toMatchObject({ code: 'WORK_ORDER_CLOSED' });
    });
  });

  describe('update', () => {
    it('refuses to edit a closed work order', async () => {
      repo.findById.mockResolvedValue(makeWorkOrder({ status: 'CANCELLED' }) as never);
      await expect(service.update('wo_1', { title: 'New title' })).rejects.toMatchObject({ code: 'WORK_ORDER_CLOSED' });
    });
  });
});
