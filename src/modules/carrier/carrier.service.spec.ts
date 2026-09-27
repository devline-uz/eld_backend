import { CarrierRepository } from './carrier.repository';
import { CarrierService } from './carrier.service';

function makeCarrier(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'carrier',
    name: 'Acme Trucking',
    dotNumber: '1234567',
    eldIdentifier: 'OBK1',
    eldRegistrationId: null,
    erodsMode: 'TEST',
    ...overrides,
  };
}

describe('CarrierService', () => {
  let repo: jest.Mocked<Pick<CarrierRepository, 'get' | 'ensure' | 'update'>>;
  let service: CarrierService;

  beforeEach(() => {
    repo = { get: jest.fn(), ensure: jest.fn(), update: jest.fn() };
    service = new CarrierService(repo as unknown as CarrierRepository);
  });

  describe('get', () => {
    it('returns the existing singleton row', async () => {
      const carrier = makeCarrier();
      repo.get.mockResolvedValue(carrier as never);

      const result = await service.get();

      expect(result).toBe(carrier);
      expect(repo.ensure).not.toHaveBeenCalled();
    });

    it('creates the singleton row on first read when missing', async () => {
      repo.get.mockResolvedValue(null);
      const carrier = makeCarrier();
      repo.ensure.mockResolvedValue(carrier as never);

      const result = await service.get();

      expect(result).toBe(carrier);
      expect(repo.ensure).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('only passes through fields present in the DTO', async () => {
      repo.get.mockResolvedValue(makeCarrier() as never);
      repo.update.mockResolvedValue(makeCarrier({ name: 'New Name' }) as never);

      await service.update({ name: 'New Name' });

      expect(repo.update).toHaveBeenCalledWith({ name: 'New Name' });
    });

    it('accepts a 4-char eldIdentifier without contradicting the Appendix A CHECK constraint', async () => {
      repo.get.mockResolvedValue(makeCarrier() as never);
      repo.update.mockResolvedValue(makeCarrier({ eldIdentifier: 'ABCD' }) as never);

      await service.update({ eldIdentifier: 'ABCD' });

      expect(repo.update).toHaveBeenCalledWith({ eldIdentifier: 'ABCD' });
    });

    // §395 Appendix A header segment: PRODUCTION output carries the ELD Registration ID.
    it('refuses erodsMode=PRODUCTION while eldRegistrationId is unset', async () => {
      repo.get.mockResolvedValue(makeCarrier({ eldRegistrationId: null }) as never);

      await expect(service.update({ erodsMode: 'PRODUCTION' })).rejects.toMatchObject({
        code: 'TRANSFER_VALIDATION_FAILED',
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('allows PRODUCTION when the registration id is supplied in the same request', async () => {
      repo.get.mockResolvedValue(makeCarrier({ eldRegistrationId: null }) as never);
      repo.update.mockResolvedValue(
        makeCarrier({ erodsMode: 'PRODUCTION', eldRegistrationId: 'AB12' }) as never,
      );

      await service.update({ erodsMode: 'PRODUCTION', eldRegistrationId: 'AB12' });

      expect(repo.update).toHaveBeenCalledWith({
        eldRegistrationId: 'AB12',
        erodsMode: 'PRODUCTION',
      });
    });
  });

  describe('getTransferConfig (B-45)', () => {
    it('returns only the four eRODS transfer fields', async () => {
      repo.get.mockResolvedValue(makeCarrier({ timezone: 'America/Chicago', eldRegistrationId: 'AB12', erodsMode: 'PRODUCTION' }) as never);
      await expect(service.getTransferConfig()).resolves.toEqual({
        timezone: 'America/Chicago',
        eldIdentifier: 'OBK1',
        eldRegistrationId: 'AB12',
        erodsMode: 'PRODUCTION',
      });
    });

    it('reports TEST by default for a fresh carrier row', async () => {
      repo.get.mockResolvedValue(null);
      repo.ensure.mockResolvedValue(makeCarrier({ timezone: 'America/New_York' }) as never);
      await expect(service.getTransferConfig()).resolves.toMatchObject({ erodsMode: 'TEST', eldIdentifier: 'OBK1' });
    });
  });
});
