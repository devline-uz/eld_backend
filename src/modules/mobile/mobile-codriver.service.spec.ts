import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { AuditRepository } from '../audit/audit.repository';
import type { AuthService } from '../auth/auth.service';
import { MobileCoDriverController } from './mobile-codriver.controller';
import { MobileCoDriverService } from './mobile-codriver.service';
import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';
import type { RodsLoginRecorder } from '../logs/rods-login-recorder';
import type { MobileTripService } from './mobile-trip.service';
import { MobileRepository } from './mobile.repository';

const ACTOR = { id: 'drv_1', type: 'driver' as const };
const META = { ip: '1.2.3.4', userAgent: 'test' };

function build() {
  const repo = { endPairing: jest.fn(), createPairing: jest.fn(), clearAssignedVehicle: jest.fn() };
  const mobileRepo = { findActivePairing: jest.fn(), findDriver: jest.fn() };
  const auth = { loginDriver: jest.fn() };
  const audit = { insert: jest.fn().mockResolvedValue(undefined) };
  const trips = { activeTripLists: jest.fn().mockResolvedValue(null) };
  const loginRecords = { login: jest.fn().mockResolvedValue(1), logout: jest.fn().mockResolvedValue(1) };
  const service = new MobileCoDriverService(
    repo as unknown as MobileFleetOpsRepository,
    mobileRepo as unknown as MobileRepository,
    auth as unknown as AuthService,
    audit as unknown as AuditRepository,
    trips as unknown as MobileTripService,
    loginRecords as unknown as RodsLoginRecorder,
  );
  return { service, repo, mobileRepo, auth, audit, trips, loginRecords };
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

  it('D-130: switch writes the §395 login of the co-driver taking the seat on the pairing unit', async () => {
    const { service, mobileRepo, auth, loginRecords } = build();
    mobileRepo.findActivePairing.mockResolvedValue(PAIRING);
    mobileRepo.findDriver.mockResolvedValue({ id: 'drv_2', username: 'jdoe' });
    auth.loginDriver.mockResolvedValue({ accessToken: 'a', refreshToken: 'b', tokenType: 'Bearer' });
    await service.switch('drv_1', { coDriverPassword: 'secret' }, ACTOR, META);
    expect(loginRecords.login).toHaveBeenCalledWith('drv_2', 'veh_1', 'CO_DRIVER_SWITCH');
    expect(loginRecords.logout).not.toHaveBeenCalled();
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

  it('D-130: leave() writes the leaving driver\'s §395 logout for the pairing unit', async () => {
    const { service, mobileRepo, loginRecords } = build();
    mobileRepo.findActivePairing.mockResolvedValue(PAIRING);
    await service.leave('drv_1', ACTOR);
    expect(loginRecords.logout).toHaveBeenCalledWith('drv_1', 'CO_DRIVER_LEAVE', { onlyVehicleId: 'veh_1' });
  });

  it('leave() is a no-op when there is no active pairing', async () => {
    const { service, mobileRepo, repo } = build();
    mobileRepo.findActivePairing.mockResolvedValue(null);
    const result = await service.leave('drv_1', ACTOR);
    expect(result).toEqual({ ended: false });
    expect(repo.endPairing).not.toHaveBeenCalled();
  });

  it('MR-22: maps a wrong co-driver password to 422 CO_DRIVER_PASSWORD_INVALID and changes nothing', async () => {
    const { service, mobileRepo, auth, repo } = build();
    mobileRepo.findActivePairing.mockResolvedValue(PAIRING);
    mobileRepo.findDriver.mockResolvedValue({ id: 'drv_2', username: 'jdoe' });
    auth.loginDriver.mockRejectedValue(new AppException(ERROR_CODES.INVALID_CREDENTIALS, 'bad', 401));
    await expect(service.switch('drv_1', { coDriverPassword: 'nope' }, ACTOR, META)).rejects.toMatchObject({
      code: 'CO_DRIVER_PASSWORD_INVALID',
      status: 422,
    });
    expect(repo.endPairing).not.toHaveBeenCalled();
  });

  it('MR-15: current() returns null without a pairing, else the other seat + trip lists', async () => {
    const { service, mobileRepo, trips } = build();
    mobileRepo.findActivePairing.mockResolvedValueOnce(null);
    expect(await service.current('drv_1')).toBeNull();

    mobileRepo.findActivePairing.mockResolvedValue(PAIRING);
    mobileRepo.findDriver.mockResolvedValue({ id: 'drv_2', firstName: 'Jane', lastName: 'Doe', username: 'jdoe', passwordHash: 'x' });
    trips.activeTripLists.mockResolvedValue({ shippingDocuments: ['B1'], trailerNumbers: ['TR-1'] });
    expect(await service.current('drv_1')).toEqual({
      pairingId: 'pair_1',
      startedAt: PAIRING.startedAt,
      coDriver: { id: 'drv_2', firstName: 'Jane', lastName: 'Doe', username: 'jdoe' },
      trip: { shippingDocuments: ['B1'], trailerNumbers: ['TR-1'] },
    });
    // seen from the other seat the co-driver is the primary
    mobileRepo.findActivePairing.mockResolvedValue({ ...PAIRING, primaryDriverId: 'drv_2', coDriverId: 'drv_1' });
    await service.current('drv_1');
    expect(mobileRepo.findDriver).toHaveBeenLastCalledWith('drv_2');
  });
});

describe('MobileCoDriverController — switch is a password login (§6.5)', () => {
  it('POST /mobile/co-driver/switch is limited to 5 requests / 60s like /auth/driver/login', () => {
    const handler = MobileCoDriverController.prototype.switch;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(5);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });
});
