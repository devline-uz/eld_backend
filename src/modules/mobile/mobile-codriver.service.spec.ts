import type { AuditRepository } from '../audit/audit.repository';
import type { AuthService } from '../auth/auth.service';
import { MobileCoDriverService } from './mobile-codriver.service';
import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';
import { MobileRepository } from './mobile.repository';

const ACTOR = { id: 'drv_1', type: 'driver' as const };
const META = { ip: '1.2.3.4', userAgent: 'test' };

function build() {
  const repo = { endPairing: jest.fn(), createPairing: jest.fn(), clearAssignedVehicle: jest.fn() };
  const mobileRepo = { findActivePairing: jest.fn(), findDriver: jest.fn() };
  const auth = { loginDriver: jest.fn() };
  const audit = { insert: jest.fn().mockResolvedValue(undefined) };
  const service = new MobileCoDriverService(
    repo as unknown as MobileFleetOpsRepository,
    mobileRepo as unknown as MobileRepository,
    auth as unknown as AuthService,
    audit as unknown as AuditRepository,
  );
  return { service, repo, mobileRepo, auth, audit };
}

const PAIRING = { id: 'pair_1', primaryDriverId: 'drv_1', coDriverId: 'drv_2', vehicleId: 'veh_1', startedAt: new Date('2026-01-01') };

describe('MobileCoDriverService (MB-3)', () => {
  it('404s when there is no active pairing to switch', async () => {
    const { service, mobileRepo } = build();
    mobileRepo.findActivePairing.mockResolvedValue(null);
    await expect(service.switch('drv_1', { coDriverPassword: 'x' }, ACTOR, META)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('verifies the co-driver password via AuthService.loginDriver, never re-hashing itself', async () => {
    const { service, mobileRepo, auth, repo, audit } = build();
    mobileRepo.findActivePairing.mockResolvedValue(PAIRING);
    mobileRepo.findDriver.mockResolvedValue({ id: 'drv_2', username: 'jdoe' });
    auth.loginDriver.mockResolvedValue({ accessToken: 'a', refreshToken: 'b', tokenType: 'Bearer' });

    const result = await service.switch('drv_1', { coDriverPassword: 'secret' }, ACTOR, META);

    expect(auth.loginDriver).toHaveBeenCalledWith('jdoe', 'secret', META);
    expect(result).toEqual({ accessToken: 'a', refreshToken: 'b', tokenType: 'Bearer' });
    expect(repo.endPairing).toHaveBeenCalledWith('pair_1', 'drv_1', expect.any(Date));
    expect(repo.createPairing).toHaveBeenCalledWith(
      expect.objectContaining({ primaryDriverId: 'drv_2', coDriverId: 'drv_1', vehicleId: 'veh_1' }),
    );
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'CO_DRIVER_SWITCHED' }));
  });

  it('propagates AuthService.loginDriver rejection (wrong password) without swapping the pairing', async () => {
    const { service, mobileRepo, auth, repo } = build();
    mobileRepo.findActivePairing.mockResolvedValue(PAIRING);
    mobileRepo.findDriver.mockResolvedValue({ id: 'drv_2', username: 'jdoe' });
    auth.loginDriver.mockRejectedValue(Object.assign(new Error('bad creds'), { code: 'INVALID_CREDENTIALS', status: 401 }));

    await expect(service.switch('drv_1', { coDriverPassword: 'wrong' }, ACTOR, META)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(repo.endPairing).not.toHaveBeenCalled();
  });

  it('leave() ends the pairing and clears the leaving driver\'s assigned vehicle', async () => {
    const { service, mobileRepo, repo, audit } = build();
    mobileRepo.findActivePairing.mockResolvedValue(PAIRING);

    const result = await service.leave('drv_1', ACTOR);

    expect(result).toEqual({ ended: true });
    expect(repo.endPairing).toHaveBeenCalledWith('pair_1', 'drv_1', expect.any(Date));
    expect(repo.clearAssignedVehicle).toHaveBeenCalledWith('drv_1');
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'CO_DRIVER_LEFT' }));
  });

  it('leave() is a no-op when there is no active pairing', async () => {
    const { service, mobileRepo, repo } = build();
    mobileRepo.findActivePairing.mockResolvedValue(null);
    const result = await service.leave('drv_1', ACTOR);
    expect(result).toEqual({ ended: false });
    expect(repo.endPairing).not.toHaveBeenCalled();
  });
});
