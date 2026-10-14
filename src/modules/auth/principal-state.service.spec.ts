import { PRINCIPAL_STATE_TTL_MS, PrincipalStateService } from './principal-state.service';

/** CODE-012 — an access token is checked against the live user/session state. */
describe('PrincipalStateService', () => {
  const ACTIVE = { id: 'u1', status: 'ACTIVE', role: { key: 'DISPATCHER', permissions: { trips: 'FULL' } } };

  function build(user: unknown = ACTIVE, lineageLive = true) {
    const users = { findByIdWithRole: jest.fn().mockResolvedValue(user) };
    const sessions = { isLineageLive: jest.fn().mockResolvedValue(lineageLive) };
    const events = { publish: jest.fn().mockResolvedValue(undefined) };
    const service = new PrincipalStateService(users as never, sessions as never, events as never);
    return { service, users, sessions, events };
  }

  afterEach(() => jest.useRealTimers());

  it('returns the role and permissions from the DB, not from the token', async () => {
    const { service, sessions } = build();
    await expect(service.resolveUser('u1', 's1')).resolves.toEqual({ roleKey: 'DISPATCHER', permissions: { trips: 'FULL' } });
    expect(sessions.isLineageLive).toHaveBeenCalledWith('s1', 'u1');
  });

  it.each([
    ['a deleted user', null, true],
    ['a DISABLED user', { ...ACTIVE, status: 'DISABLED' }, true],
    ['a revoked session', ACTIVE, false],
  ])('refuses %s', async (_label, user, live) => {
    const { service } = build(user, live);
    await expect(service.resolveUser('u1', 's1')).resolves.toBeNull();
  });

  it('a legacy token without sid is checked on the user alone', async () => {
    const { service, sessions } = build();
    await expect(service.resolveUser('u1')).resolves.not.toBeNull();
    expect(sessions.isLineageLive).not.toHaveBeenCalled();
  });

  it('caches for the TTL, then asks the DB again', async () => {
    jest.useFakeTimers();
    const { service, users } = build();
    await service.resolveUser('u1', 's1');
    await service.resolveUser('u1', 's1');
    expect(users.findByIdWithRole).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(PRINCIPAL_STATE_TTL_MS + 1);
    await service.resolveUser('u1', 's1');
    expect(users.findByIdWithRole).toHaveBeenCalledTimes(2);
  });

  it('invalidateUser drops the cache at once and tells the realtime gateway', async () => {
    const { service, users, events } = build();
    await service.resolveUser('u1', 's1');
    users.findByIdWithRole.mockResolvedValue({ ...ACTIVE, status: 'DISABLED' });
    await service.invalidateUser('u1');
    await expect(service.resolveUser('u1', 's1')).resolves.toBeNull();
    expect(events.publish).toHaveBeenCalledWith('realtime.push', { room: 'user:u1', event: 'auth.revoked', payload: {} });
  });

  it('invalidateUsers covers every holder of an edited role', async () => {
    const { service, events } = build();
    await service.invalidateUsers(['u1', 'u2']);
    expect(events.publish).toHaveBeenCalledTimes(2);
  });

  describe('drivers and cross-replica eviction', () => {
    const DRIVER = { id: 'd1', status: 'ACTIVE', deletedAt: null };

    function buildFull(driver: unknown = DRIVER, hasLive = true) {
      const users = { findByIdWithRole: jest.fn().mockResolvedValue(ACTIVE) };
      const sessions = { isLineageLive: jest.fn().mockResolvedValue(true) };
      const events = { publish: jest.fn().mockResolvedValue(undefined) };
      const drivers = { findById: jest.fn().mockResolvedValue(driver) };
      const driverSessions = { hasLiveSession: jest.fn().mockResolvedValue(hasLive) };
      let relayed: ((m: { room: string | string[]; event: string; payload: unknown }) => void) | undefined;
      const relay = { onRelayed: jest.fn((h: typeof relayed) => { relayed = h; return () => undefined; }) };
      const service = new PrincipalStateService(
        users as never, sessions as never, events as never, drivers as never, driverSessions as never, relay as never,
      );
      service.onModuleInit();
      return { service, users, events, drivers, driverSessions, relay: (m: Parameters<NonNullable<typeof relayed>>[0]) => relayed?.(m) };
    }

    it('an ACTIVE driver with a live app session passes', async () => {
      const { service } = buildFull();
      await expect(service.resolveDriver('d1')).resolves.toBe(true);
    });

    it.each([
      ['INACTIVE', { ...DRIVER, status: 'INACTIVE' }, true],
      ['TERMINATED', { ...DRIVER, status: 'TERMINATED' }, true],
      ['deleted', { ...DRIVER, deletedAt: new Date() }, true],
      ['missing', null, true],
      ['without any live session', DRIVER, false],
    ])('refuses a driver that is %s', async (_label, driver, live) => {
      const { service } = buildFull(driver, live);
      await expect(service.resolveDriver('d1')).resolves.toBe(false);
    });

    it('a refusal is not cached: a fresh login is honoured at once', async () => {
      const { service, driverSessions } = buildFull(DRIVER, false);
      await expect(service.resolveDriver('d1')).resolves.toBe(false);
      driverSessions.hasLiveSession.mockResolvedValue(true);
      await expect(service.resolveDriver('d1')).resolves.toBe(true);
    });

    it('invalidateDriver evicts at once and drops the driver sockets', async () => {
      const { service, drivers, events } = buildFull();
      await service.resolveDriver('d1');
      drivers.findById.mockResolvedValue({ ...DRIVER, status: 'TERMINATED' });
      await service.invalidateDriver('d1');
      await expect(service.resolveDriver('d1')).resolves.toBe(false);
      expect(events.publish).toHaveBeenCalledWith('realtime.push', { room: 'driver:d1', event: 'auth.revoked', payload: {} });
    });

    it('a relayed auth.revoked from another replica evicts users and drivers here', async () => {
      const { service, users, drivers, relay } = buildFull();
      await service.resolveUser('u1', 's1');
      await service.resolveDriver('d1');
      users.findByIdWithRole.mockResolvedValue({ ...ACTIVE, status: 'DISABLED' });
      drivers.findById.mockResolvedValue({ ...DRIVER, status: 'INACTIVE' });
      relay({ room: ['user:u1', 'driver:d1'], event: 'auth.revoked', payload: {} });
      await expect(service.resolveUser('u1', 's1')).resolves.toBeNull();
      await expect(service.resolveDriver('d1')).resolves.toBe(false);
    });

    it('ignores other relayed events', async () => {
      const { service, users, relay } = buildFull();
      await service.resolveUser('u1', 's1');
      relay({ room: 'user:u1', event: 'message.new', payload: {} });
      await service.resolveUser('u1', 's1');
      expect(users.findByIdWithRole).toHaveBeenCalledTimes(1);
    });

    it('a broadcast failure never blocks the local eviction', async () => {
      const { service, events, drivers } = buildFull();
      await service.resolveDriver('d1');
      events.publish.mockRejectedValueOnce(new Error('redis down'));
      drivers.findById.mockResolvedValue({ ...DRIVER, status: 'INACTIVE' });
      await expect(service.invalidateDriver('d1')).resolves.toBeUndefined();
      await expect(service.resolveDriver('d1')).resolves.toBe(false);
    });
  });
});
