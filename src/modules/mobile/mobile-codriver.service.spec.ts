import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { EventBusService } from '../../core/events/event-bus.service';
import type { AuditRepository } from '../audit/audit.repository';
import type { AuthService } from '../auth/auth.service';
import { MobileCoDriverController } from './mobile-codriver.controller';
import { MobileCoDriverService } from './mobile-codriver.service';
import { CoDriverSwitchDto } from './dto/mobile-fleet-ops.dto';
import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';
import type { RodsLoginRecorder } from '../logs/rods-login-recorder';
import type { MobileTripService } from './mobile-trip.service';
import { MobileRepository } from './mobile.repository';

const ACTOR = { id: 'drv_1', type: 'driver' as const };
const META = { ip: '1.2.3.4', userAgent: 'test' };

function build() {
  const repo = { endPairing: jest.fn(), createPairing: jest.fn(), switchSeats: jest.fn(), clearAssignedVehicle: jest.fn() };
  const mobileRepo = { findActivePairing: jest.fn(), findDriver: jest.fn(), findSyncedByClientId: jest.fn().mockResolvedValue(null), recordSyncedResult: jest.fn().mockResolvedValue({ status: 'ACCEPTED' }) };
  const auth = {
    loginDriver: jest.fn(),
    resolveDriverSessionFamily: jest.fn().mockResolvedValue(null),
    evictDriverAccess: jest.fn().mockResolvedValue(undefined),
    stashSwitchPair: jest.fn().mockResolvedValue(undefined),
    recallSwitchPair: jest.fn().mockResolvedValue(null),
  };
  const audit = { insert: jest.fn().mockResolvedValue(undefined) };
  const trips = { activeTripLists: jest.fn().mockResolvedValue(null) };
  const loginRecords = { login: jest.fn().mockResolvedValue(1), logout: jest.fn().mockResolvedValue(1) };
  const events = { publish: jest.fn<Promise<void>, [string, { room: string; event: string; payload: unknown }]>().mockResolvedValue(undefined) };
  const service = new MobileCoDriverService(
    repo as unknown as MobileFleetOpsRepository,
    mobileRepo as unknown as MobileRepository,
    auth as unknown as AuthService,
    audit as unknown as AuditRepository,
    trips as unknown as MobileTripService,
    loginRecords as unknown as RodsLoginRecorder,
    events as unknown as EventBusService,
  );
  return { service, repo, mobileRepo, auth, audit, trips, loginRecords, events };
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

    expect(auth.loginDriver).toHaveBeenCalledWith('jdoe', 'secret', META, undefined);
    expect(result).toEqual({ accessToken: 'a', refreshToken: 'b', tokenType: 'Bearer' });
    // B-0xx — one transactional repo call: pairing mirrored AND assignedVehicleId moves to the new primary.
    expect(repo.switchSeats).toHaveBeenCalledWith({
      pairingId: 'pair_1',
      endedById: 'drv_1',
      now: expect.any(Date) as Date,
      newPrimaryDriverId: 'drv_2',
      newCoDriverId: 'drv_1',
      vehicleId: 'veh_1',
    });
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'CO_DRIVER_SWITCHED' }));
  });

  it('D-161: forwards the optional `device` as the 4th loginDriver arg and returns replacedDevice', async () => {
    const { service, mobileRepo, auth } = build();
    mobileRepo.findActivePairing.mockResolvedValue(PAIRING);
    mobileRepo.findDriver.mockResolvedValue({ id: 'drv_2', username: 'jdoe' });
    const replacedDevice = { label: 'Old tablet', lastSeenAt: '2026-10-15T10:00:00.000Z', pendingCount: 3, inMotion: false as const };
    auth.loginDriver.mockResolvedValue({ accessToken: 'a', refreshToken: 'b', tokenType: 'Bearer', driverId: 'drv_2', replacedDevice });
    const device = { deviceId: '0b6f1c2e-0000-4000-8000-000000000001', deviceLabel: 'Cab tablet', platform: 'android', formFactor: 'tablet' as const, appVersion: '1.4.0' };

    const result = await service.switch('drv_1', { coDriverPassword: 'secret', device }, ACTOR, META);

    expect(auth.loginDriver).toHaveBeenCalledWith('jdoe', 'secret', META, device);
    expect(result).toMatchObject({ replacedDevice });
  });

  it('D-161: CoDriverSwitchDto accepts the auth device schema and rejects a bad one', () => {
    const device = { deviceId: '0b6f1c2e-0000-4000-8000-000000000001', deviceLabel: 'Cab tablet', platform: 'android', formFactor: 'tablet', appVersion: '1.4.0' };
    expect(CoDriverSwitchDto.safeParse({ coDriverPassword: 'x', device }).success).toBe(true);
    expect(CoDriverSwitchDto.safeParse({ coDriverPassword: 'x' }).success).toBe(true);
    expect(CoDriverSwitchDto.safeParse({ coDriverPassword: 'x', device: { ...device, deviceId: 'nope' } }).success).toBe(false);
    expect(CoDriverSwitchDto.safeParse({ coDriverPassword: 'x', device: { ...device, formFactor: 'watch' } }).success).toBe(false);
    expect(CoDriverSwitchDto.safeParse({ coDriverPassword: 'x', device: { ...device, deviceLabel: 'x'.repeat(65) } }).success).toBe(false);
  });

  it('B-0xx: switch emits bootstrap.changed to BOTH drivers; switching back is symmetric', async () => {
    const { service, mobileRepo, auth, repo, events } = build();
    auth.loginDriver.mockResolvedValue({ accessToken: 'a', refreshToken: 'b', tokenType: 'Bearer' });
    mobileRepo.findActivePairing.mockResolvedValue(PAIRING);
    mobileRepo.findDriver.mockResolvedValue({ id: 'drv_2', username: 'jdoe' });
    await service.switch('drv_1', { coDriverPassword: 'secret' }, ACTOR, META);
    const rooms = events.publish.mock.calls.map((c) => [c[1].room, c[1].event, c[1].payload]);
    expect(rooms).toEqual([
      ['driver:drv_1', 'bootstrap.changed', { reason: 'co_driver_switched' }],
      ['driver:drv_2', 'bootstrap.changed', { reason: 'co_driver_switched' }],
    ]);
    // drv_2 is now primary; switching back from drv_2 makes drv_1 primary again.
    mobileRepo.findActivePairing.mockResolvedValue({ ...PAIRING, primaryDriverId: 'drv_2', coDriverId: 'drv_1' });
    mobileRepo.findDriver.mockResolvedValue({ id: 'drv_1', username: 'jsmith' });
    await service.switch('drv_2', { coDriverPassword: 'secret' }, { id: 'drv_2', type: 'driver' }, META);
    expect(repo.switchSeats).toHaveBeenLastCalledWith(expect.objectContaining({ newPrimaryDriverId: 'drv_1', newCoDriverId: 'drv_2', vehicleId: 'veh_1' }));
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
    expect(repo.switchSeats).not.toHaveBeenCalled();
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
    expect(repo.switchSeats).not.toHaveBeenCalled();
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
    expect(repo.switchSeats).not.toHaveBeenCalled();
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

describe('D-155 — switch revokes the outgoing driver session family', () => {
  const PAIR = { accessToken: 'a2', refreshToken: 'r2', tokenType: 'Bearer' as const };
  function ready() {
    const b = build();
    b.mobileRepo.findActivePairing.mockResolvedValue(PAIRING);
    b.mobileRepo.findDriver.mockResolvedValue({ id: 'drv_2', username: 'jdoe' });
    b.auth.loginDriver.mockResolvedValue(PAIR);
    return b;
  }

  it('revokes only the caller session family, inside the seat-swap transaction, and writes the outgoing logout record once', async () => {
    const { service, auth, repo, loginRecords } = ready();
    auth.resolveDriverSessionFamily.mockResolvedValue({ familyId: 'fam_1', revoked: false });
    await service.switch('drv_1', { coDriverPassword: 'x' }, ACTOR, META, 'sess_1');
    expect(auth.resolveDriverSessionFamily).toHaveBeenCalledWith('drv_1', 'sess_1');
    expect(repo.switchSeats).toHaveBeenCalledWith(expect.objectContaining({ revokeFamily: { driverId: 'drv_1', familyId: 'fam_1' } }));
    expect(loginRecords.logout).toHaveBeenCalledTimes(1);
    expect(loginRecords.logout).toHaveBeenCalledWith('drv_1', 'CO_DRIVER_SWITCH', { onlyVehicleId: 'veh_1' });
  });

  it('a legacy token without sid revokes nothing (no family known) and writes no logout', async () => {
    const { service, repo, loginRecords } = ready();
    await service.switch('drv_1', { coDriverPassword: 'x' }, ACTOR, META, undefined);
    expect(repo.switchSeats).toHaveBeenCalledWith(expect.not.objectContaining({ revokeFamily: expect.anything() as unknown }));
    expect(loginRecords.logout).not.toHaveBeenCalled();
  });

  it('a wrong co-driver password revokes nothing', async () => {
    const { service, auth, repo, loginRecords } = ready();
    auth.resolveDriverSessionFamily.mockResolvedValue({ familyId: 'fam_1', revoked: false });
    auth.loginDriver.mockRejectedValue(new AppException(ERROR_CODES.INVALID_CREDENTIALS, 'bad', 401));
    await expect(service.switch('drv_1', { coDriverPassword: 'x' }, ACTOR, META, 'sess_1')).rejects.toMatchObject({ code: 'CO_DRIVER_PASSWORD_INVALID', status: 422 });
    expect(repo.switchSeats).not.toHaveBeenCalled();
    expect(loginRecords.logout).not.toHaveBeenCalled();
  });

  it('a stale caller token (session already revoked, no clientId) is 401 TOKEN_INVALID and does not swap back', async () => {
    const { service, auth, repo } = ready();
    auth.resolveDriverSessionFamily.mockResolvedValue({ familyId: 'fam_1', revoked: true });
    await expect(service.switch('drv_1', { coDriverPassword: 'x' }, ACTOR, META, 'sess_1')).rejects.toMatchObject({ code: 'TOKEN_INVALID', status: 401 });
    expect(auth.loginDriver).not.toHaveBeenCalled();
    expect(repo.switchSeats).not.toHaveBeenCalled();
  });

  it('with a clientId the first answer is stashed and the ledger row written; a replay returns it even though the session is now revoked', async () => {
    const { service, auth, repo, mobileRepo } = ready();
    auth.resolveDriverSessionFamily.mockResolvedValue({ familyId: 'fam_1', revoked: false });
    await service.switch('drv_1', { coDriverPassword: 'x', clientId: 'c1' }, ACTOR, META, 'sess_1');
    expect(auth.stashSwitchPair).toHaveBeenCalledWith('x', 'drv_1:c1', { accessToken: 'a2', refreshToken: 'r2' });
    expect(mobileRepo.recordSyncedResult).toHaveBeenCalledWith('drv_1', 'c1', 'co_driver_switch', expect.any(Date), 'ACCEPTED', null, expect.anything());

    mobileRepo.findSyncedByClientId.mockResolvedValue({ type: 'co_driver_switch' });
    auth.recallSwitchPair.mockResolvedValue(PAIR);
    repo.switchSeats.mockClear();
    auth.loginDriver.mockClear();
    auth.resolveDriverSessionFamily.mockResolvedValue({ familyId: 'fam_1', revoked: true });
    await expect(service.switch('drv_1', { coDriverPassword: 'x', clientId: 'c1' }, ACTOR, META, 'sess_1')).resolves.toEqual(PAIR);
    expect(repo.switchSeats).not.toHaveBeenCalled();
    expect(auth.loginDriver).not.toHaveBeenCalled();
  });

  it('a replay after the grace window, or a clientId spent on another operation, is 409 CONFLICT', async () => {
    const { service, auth, mobileRepo } = ready();
    mobileRepo.findSyncedByClientId.mockResolvedValue({ type: 'co_driver_switch' });
    auth.recallSwitchPair.mockResolvedValue(null);
    await expect(service.switch('drv_1', { coDriverPassword: 'x', clientId: 'c1' }, ACTOR, META, 's')).rejects.toMatchObject({ status: 409 });
    mobileRepo.findSyncedByClientId.mockResolvedValue({ type: 'dvir_submit' });
    await expect(service.switch('drv_1', { coDriverPassword: 'x', clientId: 'c1' }, ACTOR, META, 's')).rejects.toMatchObject({ status: 409 });
  });

  it('leave() does not touch auth sessions (the driver stays signed in on the same device)', async () => {
    const { service, auth, mobileRepo } = ready();
    mobileRepo.findActivePairing.mockResolvedValue(PAIRING);
    await service.leave('drv_1', ACTOR);
    expect(auth.resolveDriverSessionFamily).not.toHaveBeenCalled();
  });
});

describe('MobileCoDriverController — switch is a password login (§6.5)', () => {
  it('POST /mobile/co-driver/switch is limited to 5 requests / 60s like /auth/driver/login', () => {
    const handler = MobileCoDriverController.prototype.switch;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(5);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });
});
