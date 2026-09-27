import { AppException } from '../../common/errors/app.exception';
import { CoDriverPairingsRepository } from './co-driver-pairings.repository';
import { CoDriverPairingsService } from './co-driver-pairings.service';
import type { DriversRepository } from '../drivers/drivers.repository';
import type { VehiclesRepository } from '../vehicles/vehicles.repository';

describe('CoDriverPairingsService', () => {
  let pairings: jest.Mocked<Pick<CoDriverPairingsRepository, 'list' | 'findById' | 'findActiveForCoDriver' | 'create' | 'end'>>;
  let drivers: jest.Mocked<Pick<DriversRepository, 'findById'>>;
  let vehicles: jest.Mocked<Pick<VehiclesRepository, 'findById'>>;
  let service: CoDriverPairingsService;

  beforeEach(() => {
    pairings = { list: jest.fn(), findById: jest.fn(), findActiveForCoDriver: jest.fn(), create: jest.fn(), end: jest.fn() };
    drivers = { findById: jest.fn() };
    vehicles = { findById: jest.fn() };
    service = new CoDriverPairingsService(
      pairings as unknown as CoDriverPairingsRepository,
      drivers as unknown as DriversRepository,
      vehicles as unknown as VehiclesRepository,
    );
  });

  describe('create', () => {
    it('rejects pairing a driver with themselves', async () => {
      await expect(
        service.create({ primaryDriverId: 'drv_1', coDriverId: 'drv_1', vehicleId: 'veh_1' }, 'usr_1'),
      ).rejects.toThrow(AppException);
    });

    it('rejects an unknown driver', async () => {
      drivers.findById.mockResolvedValueOnce({ id: 'drv_1' } as never).mockResolvedValueOnce(null);
      vehicles.findById.mockResolvedValue({ id: 'veh_1' } as never);

      await expect(
        service.create({ primaryDriverId: 'drv_1', coDriverId: 'drv_2', vehicleId: 'veh_1' }, 'usr_1'),
      ).rejects.toThrow(AppException);
    });

    it('rejects an unknown vehicle', async () => {
      drivers.findById.mockResolvedValue({ id: 'drv_x' } as never);
      vehicles.findById.mockResolvedValue(null);

      await expect(
        service.create({ primaryDriverId: 'drv_1', coDriverId: 'drv_2', vehicleId: 'veh_1' }, 'usr_1'),
      ).rejects.toThrow(AppException);
    });

    it('rejects a second active pairing for the same co-driver + unit', async () => {
      drivers.findById.mockResolvedValue({ id: 'drv_x' } as never);
      vehicles.findById.mockResolvedValue({ id: 'veh_1' } as never);
      pairings.findActiveForCoDriver.mockResolvedValue({ id: 'pair_existing' } as never);

      await expect(
        service.create({ primaryDriverId: 'drv_1', coDriverId: 'drv_2', vehicleId: 'veh_1' }, 'usr_1'),
      ).rejects.toThrow(AppException);
      expect(pairings.create).not.toHaveBeenCalled();
    });

    it('creates a time-bounded pairing row', async () => {
      drivers.findById.mockResolvedValue({ id: 'drv_x' } as never);
      vehicles.findById.mockResolvedValue({ id: 'veh_1' } as never);
      pairings.findActiveForCoDriver.mockResolvedValue(null);
      pairings.create.mockResolvedValue({ id: 'pair_1' } as never);

      await service.create({ primaryDriverId: 'drv_1', coDriverId: 'drv_2', vehicleId: 'veh_1' }, 'usr_1');

      expect(pairings.create).toHaveBeenCalledWith(
        expect.objectContaining({
          primaryDriver: { connect: { id: 'drv_1' } },
          coDriver: { connect: { id: 'drv_2' } },
          vehicle: { connect: { id: 'veh_1' } },
          startedById: 'usr_1',
        }),
      );
    });
  });

  describe('end', () => {
    it('throws when the pairing does not exist', async () => {
      pairings.findById.mockResolvedValue(null);
      await expect(service.end('missing', 'usr_1')).rejects.toThrow(AppException);
    });

    it('rejects ending an already-ended pairing', async () => {
      pairings.findById.mockResolvedValue({ id: 'pair_1', endedAt: new Date() } as never);
      await expect(service.end('pair_1', 'usr_1')).rejects.toThrow(AppException);
      expect(pairings.end).not.toHaveBeenCalled();
    });

    it('ends an active pairing', async () => {
      pairings.findById.mockResolvedValue({ id: 'pair_1', endedAt: null } as never);
      pairings.end.mockResolvedValue({ id: 'pair_1', endedAt: new Date() } as never);

      await service.end('pair_1', 'usr_1');

      expect(pairings.end).toHaveBeenCalledWith('pair_1', 'usr_1', expect.any(Date));
    });
  });
});
