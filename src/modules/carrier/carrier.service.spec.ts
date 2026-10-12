import { CarrierRepository } from './carrier.repository';
import { CarrierService } from './carrier.service';

function makeCarrier(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'carrier',
    name: 'Acme Trucking',
    dotNumber: '1234567',
    eldIdentifier: 'OBK001',
    eldRegistrationId: null,
    erodsMode: 'TEST',
    ...overrides,
  };
}

describe('CarrierService', () => {
  let repo: jest.Mocked<Pick<CarrierRepository, 'get' | 'ensure' | 'update' | 'findActiveDriverIds' | 'findUserName'>>;
  let policy: { allowed: boolean };
  let audit: { insert: jest.Mock };
  let events: { publish: jest.Mock };
  let service: CarrierService;

  beforeEach(() => {
    repo = {
      get: jest.fn(),
      ensure: jest.fn(),
      update: jest.fn(),
      findActiveDriverIds: jest.fn().mockResolvedValue(['drv-1', 'drv-2']),
      findUserName: jest.fn().mockResolvedValue({ id: 'usr-1', name: 'Jane Admin' }),
    };
    policy = { allowed: true };
    audit = { insert: jest.fn().mockResolvedValue({}) };
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new CarrierService(repo as unknown as CarrierRepository, policy as never, audit as never, events as never);
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

    it('accepts a 6-char eldIdentifier (Appendix A 7.15) without contradicting the CHECK constraint', async () => {
      repo.get.mockResolvedValue(makeCarrier() as never);
      repo.update.mockResolvedValue(makeCarrier({ eldIdentifier: '1001ZE' }) as never);

      await service.update({ eldIdentifier: '1001ZE' });

      expect(repo.update).toHaveBeenCalledWith({ eldIdentifier: '1001ZE' });
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

  // pt30_pt40/tz.md §9.2 / §9.3 — Test PT30/40 (Virtual ELD) switch.
  describe('virtualEldEnabled', () => {
    it('GET view carries virtualEldAvailable from the env policy', async () => {
      repo.get.mockResolvedValue(makeCarrier({ virtualEldEnabled: false }) as never);
      await expect(service.view()).resolves.toMatchObject({ virtualEldEnabled: false, virtualEldAvailable: true });
      policy.allowed = false;
      await expect(service.view()).resolves.toMatchObject({ virtualEldAvailable: false });
    });

    it('GET view resolves virtualEldUpdatedBy { id, name } from virtualEldUpdatedById (null when unset)', async () => {
      repo.get.mockResolvedValue(makeCarrier({ virtualEldEnabled: true, virtualEldUpdatedById: 'usr-1' }) as never);
      await expect(service.view()).resolves.toMatchObject({ virtualEldUpdatedBy: { id: 'usr-1', name: 'Jane Admin' } });
      expect(repo.findUserName).toHaveBeenCalledWith('usr-1');
      repo.get.mockResolvedValue(makeCarrier({ virtualEldUpdatedById: null }) as never);
      await expect(service.view()).resolves.toMatchObject({ virtualEldUpdatedBy: null });
    });

    it('turning it on in TEST stores who/when, audits enabled, pushes carrier.updated + virtual_eld.changed', async () => {
      repo.get.mockResolvedValue(makeCarrier({ virtualEldEnabled: false }) as never);
      repo.update.mockImplementation(async (data) => makeCarrier({ virtualEldEnabled: true, virtualEldUpdatedAt: (data as { virtualEldUpdatedAt: Date }).virtualEldUpdatedAt }) as never);

      const result = await service.update({ virtualEldEnabled: true });

      expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ virtualEldEnabled: true, virtualEldUpdatedAt: expect.any(Date) as unknown }));
      expect(result).toMatchObject({ virtualEldEnabled: true, virtualEldAvailable: true });
      expect(audit.insert).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'carrier.virtual_eld.enabled', before: { virtualEldEnabled: false }, after: expect.objectContaining({ virtualEldEnabled: true }) as unknown }),
      );
      expect(events.publish).toHaveBeenCalledWith('realtime.push', expect.objectContaining({ room: 'fleet', event: 'carrier.updated' }));
      expect(events.publish).toHaveBeenCalledWith('realtime.push', { room: 'driver:drv-2', event: 'virtual_eld.changed', payload: { enabled: true } });
    });

    it('turning it off audits disabled', async () => {
      repo.get.mockResolvedValue(makeCarrier({ virtualEldEnabled: true }) as never);
      repo.update.mockResolvedValue(makeCarrier({ virtualEldEnabled: false }) as never);
      await service.update({ virtualEldEnabled: false });
      expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'carrier.virtual_eld.disabled' }));
      expect(events.publish).toHaveBeenCalledWith('realtime.push', { room: 'driver:drv-1', event: 'virtual_eld.changed', payload: { enabled: false } });
    });

    it('same value again is a no-op for audit/realtime', async () => {
      repo.get.mockResolvedValue(makeCarrier({ virtualEldEnabled: true }) as never);
      repo.update.mockResolvedValue(makeCarrier({ virtualEldEnabled: true }) as never);
      await service.update({ virtualEldEnabled: true });
      expect(audit.insert).not.toHaveBeenCalled();
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('409 VIRTUAL_ELD_NOT_ALLOWED when the env disallows it', async () => {
      policy.allowed = false;
      repo.get.mockResolvedValue(makeCarrier({ virtualEldEnabled: false }) as never);
      await expect(service.update({ virtualEldEnabled: true })).rejects.toMatchObject({ code: 'VIRTUAL_ELD_NOT_ALLOWED', status: 409 });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('409 VIRTUAL_ELD_REQUIRES_TEST_ERODS when enabling under PRODUCTION', async () => {
      repo.get.mockResolvedValue(makeCarrier({ virtualEldEnabled: false, erodsMode: 'PRODUCTION', eldRegistrationId: 'AB12' }) as never);
      await expect(service.update({ virtualEldEnabled: true })).rejects.toMatchObject({ code: 'VIRTUAL_ELD_REQUIRES_TEST_ERODS', status: 409 });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('409 VIRTUAL_ELD_REQUIRES_TEST_ERODS when switching to PRODUCTION while it is on', async () => {
      repo.get.mockResolvedValue(makeCarrier({ virtualEldEnabled: true, eldRegistrationId: 'AB12' }) as never);
      await expect(service.update({ erodsMode: 'PRODUCTION' })).rejects.toMatchObject({ code: 'VIRTUAL_ELD_REQUIRES_TEST_ERODS' });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('allows PRODUCTION when the same request turns the switch off', async () => {
      repo.get.mockResolvedValue(makeCarrier({ virtualEldEnabled: true, eldRegistrationId: 'AB12' }) as never);
      repo.update.mockResolvedValue(makeCarrier({ virtualEldEnabled: false, erodsMode: 'PRODUCTION', eldRegistrationId: 'AB12' }) as never);
      await expect(service.update({ erodsMode: 'PRODUCTION', virtualEldEnabled: false })).resolves.toMatchObject({ erodsMode: 'PRODUCTION' });
    });
  });

  describe('getTransferConfig (B-45)', () => {
    it('returns only the four eRODS transfer fields', async () => {
      repo.get.mockResolvedValue(makeCarrier({ timezone: 'America/Chicago', eldRegistrationId: 'AB12', erodsMode: 'PRODUCTION' }) as never);
      await expect(service.getTransferConfig()).resolves.toEqual({
        timezone: 'America/Chicago',
        eldIdentifier: 'OBK001',
        eldRegistrationId: 'AB12',
        erodsMode: 'PRODUCTION',
      });
    });

    it('reports TEST by default for a fresh carrier row', async () => {
      repo.get.mockResolvedValue(null);
      repo.ensure.mockResolvedValue(makeCarrier({ timezone: 'America/New_York' }) as never);
      await expect(service.getTransferConfig()).resolves.toMatchObject({ erodsMode: 'TEST', eldIdentifier: 'OBK001' });
    });
  });
});
