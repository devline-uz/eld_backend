import { AppException } from '../../common/errors/app.exception';
import { VehiclesRepository } from '../vehicles/vehicles.repository';
import { MaintenanceSchedulesRepository } from './maintenance-schedules.repository';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

function makeSchedule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ms_1',
    vehicleId: 'veh_1',
    name: 'Brake service',
    intervalMi: 25000,
    intervalDays: null,
    lastServiceMi: 990000,
    lastServiceAt: null,
    enabled: true,
    ...overrides,
  };
}

describe('MaintenanceSchedulesService (TZ §5.10)', () => {
  let repo: jest.Mocked<Pick<MaintenanceSchedulesRepository, 'findById' | 'create' | 'update' | 'delete' | 'list' | 'listEnabledWithVehicle'>>;
  let vehicles: jest.Mocked<Pick<VehiclesRepository, 'findById'>>;
  let service: MaintenanceSchedulesService;

  beforeEach(() => {
    repo = { findById: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), list: jest.fn(), listEnabledWithVehicle: jest.fn() };
    vehicles = { findById: jest.fn() };
    service = new MaintenanceSchedulesService(repo as unknown as MaintenanceSchedulesRepository, vehicles as unknown as VehiclesRepository);
  });

  it('404s for an unknown schedule', async () => {
    repo.findById.mockResolvedValue(null as never);
    await expect(service.get('missing')).rejects.toBeInstanceOf(AppException);
  });

  it('404s creating a schedule for an unknown vehicle', async () => {
    vehicles.findById.mockResolvedValue(null as never);
    await expect(service.create({ vehicleId: 'veh_x', name: 'Brakes', intervalMi: 25000, enabled: true })).rejects.toBeInstanceOf(AppException);
  });

  it('computes nextDueMi from lastServiceMi + intervalMi on create', async () => {
    vehicles.findById.mockResolvedValue({ id: 'veh_1', odometerMi: 990000 } as never);
    repo.create.mockImplementation((data) => Promise.resolve({ id: 'ms_1', ...data } as never));

    await service.create({ vehicleId: 'veh_1', name: 'Brakes', intervalMi: 25000, lastServiceMi: 990000, enabled: true });

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ nextDueMi: 1015000 }));
  });

  it('complete() resets lastServiceMi/nextDueMi from the current odometer', async () => {
    const schedule = makeSchedule();
    repo.findById.mockResolvedValue(schedule as never);
    vehicles.findById.mockResolvedValue({ id: 'veh_1', odometerMi: 1015200 } as never);
    repo.update.mockImplementation((_where, data) => Promise.resolve({ ...schedule, ...data } as never));

    const result = await service.complete('ms_1', {});

    expect(result.lastServiceMi).toBe(1015200);
    expect(result.nextDueMi).toBe(1040200);
  });

  describe('sweepDue', () => {
    it('returns only OVERDUE/DUE_SOON schedules', async () => {
      repo.listEnabledWithVehicle.mockResolvedValue([
        { ...makeSchedule({ id: 'ms_ok' }), vehicle: { id: 'veh_1', unitNumber: '101', odometerMi: 900000 } },
        { ...makeSchedule({ id: 'ms_over' }), vehicle: { id: 'veh_2', unitNumber: '102', odometerMi: 1016000 } },
      ] as never);

      const due = await service.sweepDue();

      expect(due).toHaveLength(1);
      expect(due[0]).toMatchObject({ scheduleId: 'ms_over', state: 'OVERDUE' });
    });
  });
});
