import { AppException } from '../../common/errors/app.exception';
import { AppConfigService } from '../../core/config/config.service';
import type { StoragePort } from '../../core/storage/storage.port';
import type { AttachmentsService } from '../attachments/attachments.service';
import type { TokenService } from '../auth/token.service';
import type { TransactionalMailPort } from '../../core/mail/mail.port';
import type { AuthService } from '../auth/auth.service';
import { DriverEmailChangeService } from './driver-email-change.service';
import { DriversRepository } from './drivers.repository';
import { DriversService } from './drivers.service';
import { CreateDriverDocumentDto, CreateDriverDto, ImportDriversDto, UpdateDriverDto } from './dto/drivers.dto';

function makeDriver(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'drv_1',
    username: 'jsmith',
    passwordHash: 'argon2-hash',
    firstName: 'John',
    lastName: 'Smith',
    cdlNumber: 'D1234567',
    cdlState: 'OH',
    status: 'ACTIVE',
    homeTerminalName: 'Columbus, OH',
    homeTerminalTimezone: 'America/New_York',
    hosRuleset: 'US_70_8_PROPERTY',
    allowPersonalConveyance: false,
    allowYardMove: false,
    adverseDrivingEnabled: false,
    shortHaulException: false,
    splitSleeperEnabled: false,
    eldExempt: false,
    email: null,
    emailVerifiedAt: null,
    ...overrides,
  };
}

const taken = (code: string, field: string, message: string) => ({ code, status: 409, message, details: { [field]: message } });
const TAKEN = {
  username: taken('USERNAME_TAKEN', 'username', 'A driver with this username already exists.'),
  email: taken('EMAIL_TAKEN', 'email', 'A driver with this email address already exists.'),
  phone: taken('PHONE_TAKEN', 'phone', 'A driver with this phone number already exists.'),
  cdlNumber: taken('CDL_NUMBER_TAKEN', 'cdlNumber', 'A driver with this licence number already exists.'),
  assignedVehicleId: taken('VEHICLE_ALREADY_ASSIGNED', 'assignedVehicleId', 'This unit already has a driver assigned.'),
};

const baseDto = {
  username: 'jsmith',
  firstName: 'John',
  lastName: 'Smith',
  cdlNumber: 'D1234567',
  cdlState: 'OH',
  homeTerminalName: 'Columbus, OH',
  homeTerminalTimezone: 'America/New_York',
  hosRuleset: 'US_70_8_PROPERTY' as const,
  allowPersonalConveyance: false,
  allowYardMove: false,
  adverseDrivingEnabled: false,
  shortHaulException: false,
  splitSleeperEnabled: false,
  eldExempt: false,
  sendInvitation: false,
};

describe('DriversService', () => {
  let repo: jest.Mocked<
    Pick<
      DriversRepository,
      | 'findByUsername'
      | 'findByEmail'
      | 'findById'
      | 'create'
      | 'update'
      | 'delete'
      | 'list'
      | 'listAll'
      | 'listDocuments'
      | 'findDocument'
      | 'createDocument'
      | 'deleteDocument'
      | 'revokeAllSessions'
      | 'endActivePairings'
      | 'findLiveIdByPhoneKey'
      | 'findLiveIdByCdlKey'
      | 'findVehicleForAssignment'
      | 'createWithVehicle'
      | 'fleetManagerExists'
      | 'findOpenTrips'
      | 'softDeleteUnlessOnTrip'
      | 'findLiveIdByPendingEmail'
      | 'updateIfState'
    >
  >;
  let tokens: jest.Mocked<
    Pick<
      TokenService,
      | 'signDriverEmailVerifyToken'
      | 'verifyDriverEmailVerifyToken'
      | 'signDriverEmailChangeToken'
      | 'verifyDriverEmailChangeToken'
      | 'signDriverEmailChangeCancelToken'
      | 'verifyDriverEmailChangeCancelToken'
    >
  >;
  let mail: jest.Mocked<TransactionalMailPort>;
  let auth: jest.Mocked<Pick<AuthService, 'assertUserReauth'>>;
  let events: { publish: jest.Mock };
  let emailChange: DriverEmailChangeService;
  const ENV: Record<string, unknown> = { DRIVER_EMAIL_CHANGE_TTL: '24h', DRIVER_EMAIL_CHANGE_HOLD_HOURS: 48, WEB_APP_URL: 'https://web.example' };
  const makeConfig = (echo: boolean) =>
    ({ isProduction: false, echoOneTimeSecrets: echo, get: (key: string) => ENV[key] }) as unknown as AppConfigService;
  /** Builds the service (and its email-change collaborator) over the current mocks. */
  const build = (cfg: AppConfigService, carrier?: unknown) => {
    emailChange = new DriverEmailChangeService(repo as never, tokens as never, auth as never, cfg, mail, events as never);
    return new DriversService(
      repo as unknown as DriversRepository,
      tokens as unknown as TokenService,
      cfg,
      mail,
      storage as unknown as StoragePort,
      attachments as unknown as AttachmentsService,
      emailChange,
      carrier as never,
    );
  };
  let storage: jest.Mocked<Pick<StoragePort, 'presignPut' | 'presignGet' | 'delete'>>;
  let attachments: jest.Mocked<Pick<AttachmentsService, 'presignKey'>>;
  let config: AppConfigService;
  let service: DriversService;

  beforeEach(() => {
    repo = {
      findByUsername: jest.fn(),
      findByEmail: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      list: jest.fn(),
      listAll: jest.fn(),
      listDocuments: jest.fn(),
      findDocument: jest.fn(),
      createDocument: jest.fn(),
      deleteDocument: jest.fn(),
      revokeAllSessions: jest.fn().mockResolvedValue(0),
      endActivePairings: jest.fn().mockResolvedValue(0),
      findLiveIdByPhoneKey: jest.fn().mockResolvedValue(null),
      findLiveIdByCdlKey: jest.fn().mockResolvedValue(null),
      findVehicleForAssignment: jest.fn().mockResolvedValue(null),
      createWithVehicle: jest.fn(),
      fleetManagerExists: jest.fn().mockResolvedValue(true),
      findOpenTrips: jest.fn().mockResolvedValue([]),
      // The real method runs both steps in one locked transaction (CODE-062); the mock replays them
      // through the same spies so each test can steer the open-trip check and see the write.
      softDeleteUnlessOnTrip: jest.fn(),
      findLiveIdByPendingEmail: jest.fn().mockResolvedValue(null),
      updateIfState: jest.fn().mockResolvedValue(true),
    };
    repo.softDeleteUnlessOnTrip.mockImplementation(async (id: string) => {
      const openTrips = await repo.findOpenTrips(id);
      if (openTrips.length > 0) return { openTrips };
      const deleted = await repo.update({ id }, { status: 'TERMINATED', deletedAt: new Date(), assignedVehicle: { disconnect: true } });
      return { deleted };
    });
    repo.findByEmail.mockResolvedValue(null);
    tokens = {
      signDriverEmailVerifyToken: jest.fn(),
      verifyDriverEmailVerifyToken: jest.fn(),
      signDriverEmailChangeToken: jest.fn().mockReturnValue('confirm-token'),
      verifyDriverEmailChangeToken: jest.fn(),
      signDriverEmailChangeCancelToken: jest.fn().mockReturnValue('cancel-token'),
      verifyDriverEmailChangeCancelToken: jest.fn(),
    };
    auth = { assertUserReauth: jest.fn().mockResolvedValue(undefined) };
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    mail = { send: jest.fn().mockResolvedValue({ delivered: false, reference: 'not-configured' }) };
    storage = { presignPut: jest.fn().mockResolvedValue('https://minio/put'), presignGet: jest.fn().mockResolvedValue('https://minio/get'), delete: jest.fn().mockResolvedValue(undefined) };
    attachments = { presignKey: jest.fn().mockResolvedValue({ url: 'https://minio/get', expiresAt: '2026-09-24T00:15:00.000Z' }) };
    config = makeConfig(true);
    service = build(config);
  });

  it('list parses sort and strips passwordHash from every row', async () => {
    repo.list.mockResolvedValue({ items: [makeDriver()], total: 1 } as never);
    const result = await service.list({ page: 1, limit: 25 });
    expect(repo.list).toHaveBeenCalledWith({ status: undefined, q: undefined }, 1, 25, { registeredAt: 'desc' });
    expect(result.items[0]).not.toHaveProperty('passwordHash');
  });

  it('get returns the driver view when found', async () => {
    repo.findById.mockResolvedValue(makeDriver() as never);
    const result = await service.get('drv_1');
    expect(result.username).toBe('jsmith');
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('update applies a partial input and strips passwordHash', async () => {
    repo.findById.mockResolvedValue(makeDriver() as never);
    repo.update.mockResolvedValue(makeDriver({ firstName: 'Jane' }) as never);
    const result = await service.update('drv_1', { firstName: 'Jane', fleetManagerId: 'fm_1' });
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'drv_1' },
      expect.objectContaining({ firstName: 'Jane', fleetManager: { connect: { id: 'fm_1' } } }),
    );
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('update disconnects fleetManager when fleetManagerId is explicitly null', async () => {
    repo.findById.mockResolvedValue(makeDriver() as never);
    repo.update.mockResolvedValue(makeDriver() as never);
    await service.update('drv_1', { fleetManagerId: null } as never);
    expect(repo.update).toHaveBeenCalledWith({ id: 'drv_1' }, { fleetManager: { disconnect: true } });
  });

  it('update rejects an email already used by another driver', async () => {
    repo.findById.mockResolvedValue(makeDriver() as never);
    repo.findByEmail.mockResolvedValue(makeDriver({ id: 'drv_2' }) as never);
    await expect(service.update('drv_1', { email: 'taken@example.com' })).rejects.toThrow(AppException);
  });

  it('exportAll maps every driver to a CreateDriverDto shape, never including passwordHash', async () => {
    repo.listAll.mockResolvedValue([makeDriver({ email: null, phone: null, eldExemptReason: null })] as never);
    const rows = await service.exportAll();
    expect(rows[0]).not.toHaveProperty('passwordHash');
    expect(rows[0]).toEqual(expect.objectContaining({ username: 'jsmith', email: undefined }));
  });

  it('never returns passwordHash from get/create/update (TZ §6.5)', async () => {
    repo.findByUsername.mockResolvedValue(null);
    repo.create.mockResolvedValue(makeDriver() as never);

    const created = await service.create(baseDto);

    expect(created).not.toHaveProperty('passwordHash');
  });

  it('hashes a generated temp password when none is supplied', async () => {
    repo.findByUsername.mockResolvedValue(null);
    repo.create.mockResolvedValue(makeDriver() as never);

    await service.create(baseDto);

    const [createArg] = repo.create.mock.calls[0] as [{ passwordHash: string }];
    expect(createArg.passwordHash).toMatch(/^\$argon2id\$/);
  });

  describe('home terminal is optional on create (web panel)', () => {
    const { homeTerminalName: _omit, ...withoutTerminal } = baseDto;

    it('CreateDriverDto accepts a missing / blank home terminal, trims it, and still caps it at 120 chars', () => {
      const missing = CreateDriverDto.safeParse(withoutTerminal);
      expect(missing.success).toBe(true);
      expect(missing.success && missing.data.homeTerminalName).toBeUndefined();
      expect(missing.success && missing.data.homeTerminalTimezone).toBe('America/New_York');
      expect(CreateDriverDto.safeParse({ ...withoutTerminal, homeTerminalName: '' }).success).toBe(true);
      const trimmed = CreateDriverDto.safeParse({ ...withoutTerminal, homeTerminalName: '  Columbus, OH  ' });
      expect(trimmed.success && trimmed.data.homeTerminalName).toBe('Columbus, OH');
      expect(CreateDriverDto.safeParse({ ...withoutTerminal, homeTerminalName: 'x'.repeat(120) }).success).toBe(true);
      expect(CreateDriverDto.safeParse({ ...withoutTerminal, homeTerminalName: 'x'.repeat(121) }).success).toBe(false);
      expect(CreateDriverDto.safeParse({ ...withoutTerminal, homeTerminalName: 42 }).success).toBe(false);
    });

    it('UpdateDriverDto leaves an omitted home terminal untouched and still caps it at 120 chars', () => {
      const parsed = UpdateDriverDto.safeParse({ firstName: 'Jane' });
      expect(parsed.success && parsed.data.homeTerminalName).toBeUndefined();
      expect(UpdateDriverDto.safeParse({ homeTerminalName: 'x'.repeat(121) }).success).toBe(false);
    });

    it('stores an empty string (NOT NULL column) when no home terminal is sent', async () => {
      repo.findByUsername.mockResolvedValue(null);
      repo.create.mockResolvedValue(makeDriver({ homeTerminalName: '' }) as never);

      await service.create(CreateDriverDto.parse(withoutTerminal));

      const [createArg] = repo.create.mock.calls[0] as [{ homeTerminalName: string; homeTerminalTimezone: string }];
      expect(createArg.homeTerminalName).toBe('');
      expect(createArg.homeTerminalTimezone).toBe('America/New_York');
    });
  });

  it('rejects a duplicate username', async () => {
    repo.findByUsername.mockResolvedValue(makeDriver() as never);

    await expect(service.create(baseDto)).rejects.toThrow(AppException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('B-82 — sendInvitation: false never dispatches a code; true (with an email) does', async () => {
    repo.findByUsername.mockResolvedValue(null);
    repo.create.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);

    const noInvite = await service.create(baseDto);
    expect(noInvite.inviteCode).toBeUndefined();
    expect(mail.send).not.toHaveBeenCalled();

    const withInvite = await service.create({ ...baseDto, sendInvitation: true, email: 'jsmith@example.com' });
    expect(withInvite.inviteCode).toMatch(/^\d{6}$/);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it.each([[''], ['   '], [null]])('create with a blank email (%j) stores no email and sends no invite', async (email) => {
    repo.findByUsername.mockResolvedValue(null);
    repo.create.mockImplementation(async (input) => makeDriver({ email: (input as { email?: string | null }).email ?? null }) as never);

    const dto = CreateDriverDto.parse({ ...baseDto, email, sendInvitation: true });
    const result = await service.create(dto);

    const [createArg] = repo.create.mock.calls[0] as [{ email?: string | null }];
    expect(createArg.email).toBeUndefined();
    expect(repo.findByEmail).not.toHaveBeenCalled();
    expect(result.inviteCode).toBeUndefined();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('BE-004 — an admin-entered password is never overwritten by the invitation code', async () => {
    repo.findByUsername.mockResolvedValue(null);
    repo.create.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);

    const created = await service.create({ ...baseDto, password: 'Admin-Chosen-1', sendInvitation: true, email: 'jsmith@example.com' });
    expect(created.inviteCode).toBeUndefined();
    // Only the create wrote a hash (of the admin's password) — no second write with a code.
    expect(repo.update).not.toHaveBeenCalled();
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send.mock.calls[0][0].text).not.toMatch(/\d{6}/);
  });

  it('BE-004 — import rows with a password do not get a one-time code either', async () => {
    repo.findByUsername.mockResolvedValue(null);
    repo.create.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);
    await service.importMany({
      drivers: [{ ...baseDto, email: 'jsmith@example.com', password: 'Admin-Chosen-1' }],
      options: { duplicateStrategy: 'UPDATE', sendInvitations: true, applyDefaultExemptions: false },
    });
    expect(repo.update).not.toHaveBeenCalled();
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it('BE-010 — an unknown fleetManagerId is a 422 keyed fleetManagerId on create and update', async () => {
    repo.findByUsername.mockResolvedValue(null);
    repo.fleetManagerExists.mockResolvedValue(false);
    const fm = '33333333-3333-4333-8333-333333333333';
    await expect(service.create({ ...baseDto, fleetManagerId: fm })).rejects.toMatchObject({
      status: 422,
      details: { fleetManagerId: 'Fleet manager not found.' },
    });
    expect(repo.create).not.toHaveBeenCalled();
    repo.findById.mockResolvedValue(makeDriver() as never);
    await expect(service.update('drv_1', { fleetManagerId: fm })).rejects.toMatchObject({ status: 422 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('BE-013 — remove() is a 409 listing the open trips, and deletes nothing', async () => {
    repo.findById.mockResolvedValue(makeDriver() as never);
    repo.findOpenTrips.mockResolvedValue([{ id: 'trp_1', number: 'TRP-1', status: 'ASSIGNED' }]);
    await expect(service.remove('drv_1')).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      details: { openTrips: [{ id: 'trp_1', number: 'TRP-1', status: 'ASSIGNED' }] },
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('CODE-011 — PATCH status INACTIVE/TERMINATED with open trips is a 409 and writes nothing', async () => {
    repo.findById.mockResolvedValue(makeDriver({ status: 'ACTIVE' }) as never);
    repo.findOpenTrips.mockResolvedValue([{ id: 'trp_1', number: 'TRP-1', status: 'ASSIGNED' }]);
    await expect(service.update('drv_1', { status: 'TERMINATED' })).rejects.toMatchObject({ status: 409 });
    await expect(service.update('drv_1', { status: 'INACTIVE' })).rejects.toMatchObject({ status: 409 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('CODE-011 — PATCH status INACTIVE without open trips frees the assigned unit', async () => {
    repo.findById.mockResolvedValue(makeDriver({ status: 'ACTIVE', assignedVehicleId: 'veh_1' }) as never);
    repo.update.mockResolvedValue(makeDriver({ status: 'INACTIVE', assignedVehicleId: null }) as never);
    await service.update('drv_1', { status: 'INACTIVE' });
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'drv_1' },
      expect.objectContaining({ status: 'INACTIVE', assignedVehicle: { disconnect: true } }),
    );
  });

  describe('driver disable — app access ends at once', () => {
    let principals: { invalidateDriver: jest.Mock };
    let busEvents: { publish: jest.Mock };
    let svc: DriversService;
    beforeEach(() => {
      principals = { invalidateDriver: jest.fn().mockResolvedValue(undefined) };
      busEvents = { publish: jest.fn().mockResolvedValue(undefined) };
      svc = new DriversService(
        repo as unknown as DriversRepository,
        tokens as unknown as TokenService,
        config,
        mail,
        storage as unknown as StoragePort,
        attachments as unknown as AttachmentsService,
        emailChange,
        undefined,
        busEvents as never,
        principals as never,
      );
    });

    it.each(['INACTIVE', 'TERMINATED'] as const)('PATCH %s revokes sessions, ends pairings, evicts and audits', async (status) => {
      repo.findById.mockResolvedValue(makeDriver({ status: 'ACTIVE', assignedVehicleId: null }) as never);
      repo.update.mockResolvedValue(makeDriver({ status }) as never);
      repo.revokeAllSessions.mockResolvedValue(2);
      repo.endActivePairings.mockResolvedValue(1);
      await svc.update('drv_1', { status });
      expect(repo.endActivePairings).toHaveBeenCalledWith('drv_1', undefined);
      expect(repo.revokeAllSessions).toHaveBeenCalledWith('drv_1');
      expect(principals.invalidateDriver).toHaveBeenCalledWith('drv_1');
      expect(busEvents.publish).toHaveBeenCalledWith(
        'audit.record',
        expect.objectContaining({ action: 'APP_ACCESS_REVOKED', objectId: 'drv_1', after: { sessionsRevoked: 2, pairingsEnded: 1 } }),
      );
    });

    it('a PATCH that keeps the driver ACTIVE leaves the app sessions alone', async () => {
      repo.findById.mockResolvedValue(makeDriver({ status: 'ACTIVE' }) as never);
      repo.update.mockResolvedValue(makeDriver() as never);
      await svc.update('drv_1', { firstName: 'Jo' });
      expect(repo.revokeAllSessions).not.toHaveBeenCalled();
      expect(principals.invalidateDriver).not.toHaveBeenCalled();
    });

    it('remove() cuts app access too', async () => {
      repo.findById.mockResolvedValue(makeDriver() as never);
      repo.update.mockResolvedValue(makeDriver({ status: 'TERMINATED' }) as never);
      await svc.remove('drv_1');
      expect(repo.revokeAllSessions).toHaveBeenCalledWith('drv_1');
      expect(principals.invalidateDriver).toHaveBeenCalledWith('drv_1');
    });

    it('an import UPDATE to TERMINATED follows PATCH: open trips block it, otherwise unit freed and access cut', async () => {
      repo.findByUsername.mockResolvedValue(makeDriver({ status: 'ACTIVE', assignedVehicleId: 'veh_1' }) as never);
      repo.findOpenTrips.mockResolvedValueOnce([{ id: 't1', number: 'TR-1' }] as never);
      const blocked = await svc.importMany({ drivers: [{ ...baseDto, username: 'jsmith', status: 'TERMINATED' }] as never });
      expect(blocked.failed).toHaveLength(1);
      expect(repo.update).not.toHaveBeenCalled();

      repo.update.mockResolvedValue(makeDriver({ status: 'TERMINATED' }) as never);
      const done = await svc.importMany({ drivers: [{ ...baseDto, username: 'jsmith', status: 'TERMINATED' }] as never });
      expect(done.updated).toBe(1);
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'drv_1' },
        expect.objectContaining({ status: 'TERMINATED', assignedVehicle: { disconnect: true } }),
      );
      expect(principals.invalidateDriver).toHaveBeenCalledWith('drv_1');
    });
  });

  it('rejects an unknown driver id on update', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(service.update('missing', {})).rejects.toThrow(AppException);
  });

  it('remove() soft-deletes (status -> TERMINATED), never calls repo.delete (bugs.md B-009)', async () => {
    repo.findById.mockResolvedValue(makeDriver() as never);
    repo.update.mockResolvedValue(makeDriver({ status: 'TERMINATED' }) as never);

    await service.remove('drv_1');

    const [where, data] = repo.update.mock.calls[0];
    expect(where).toEqual({ id: 'drv_1' });
    expect(data).toMatchObject({ status: 'TERMINATED', assignedVehicle: { disconnect: true } });
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  describe('soft delete frees username / email (partial unique indexes on live rows)', () => {
    const p2002 = (target: string[]) => Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target } });

    it('re-creating a driver with a soft-deleted driver\'s username and email succeeds', async () => {
      // The live-only lookups don't see the deleted row, so nothing collides.
      repo.findByUsername.mockResolvedValue(null);
      repo.findByEmail.mockResolvedValue(null);
      repo.create.mockResolvedValue(makeDriver({ id: 'drv_new', email: 'jsmith@example.com' }) as never);
      const result = await service.create({ ...baseDto, email: 'jsmith@example.com' });
      expect(result.id).toBe('drv_new');
      expect(repo.findByUsername).toHaveBeenCalledWith('jsmith');
      expect(repo.findByEmail).toHaveBeenCalledWith('jsmith@example.com');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ username: 'jsmith', email: 'jsmith@example.com' }));
    });

    it('a duplicate username among live drivers is still a 409', async () => {
      repo.findByUsername.mockResolvedValue(makeDriver() as never);
      await expect(service.create(baseDto)).rejects.toMatchObject(TAKEN.username);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('a duplicate email among live drivers is still a 409', async () => {
      repo.findByUsername.mockResolvedValue(null);
      repo.findByEmail.mockResolvedValue(makeDriver({ id: 'drv_2', email: 'x@example.com' }) as never);
      await expect(service.create({ ...baseDto, email: 'x@example.com' })).rejects.toMatchObject(TAKEN.email);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('maps a racing P2002 on create to a 409 CONFLICT naming the column', async () => {
      repo.findByUsername.mockResolvedValue(null);
      repo.create.mockRejectedValue(p2002(['username']));
      await expect(service.create(baseDto)).rejects.toMatchObject(TAKEN.username);
    });

    it('rethrows non-P2002 errors from create untouched', async () => {
      repo.findByUsername.mockResolvedValue(null);
      const boom = new Error('db down');
      repo.create.mockRejectedValue(boom);
      await expect(service.create(baseDto)).rejects.toBe(boom);
    });

    it('update maps a racing P2002 on email to a 409', async () => {
      repo.findById.mockResolvedValue(makeDriver() as never);
      repo.update.mockRejectedValue(p2002(['email']));
      await expect(
        service.update('drv_1', { email: 'y@example.com', currentPassword: 'pw' }, { id: 'usr_1', type: 'user' }),
      ).rejects.toMatchObject(TAKEN.email);
    });

    it('get treats a soft-deleted driver as not found', async () => {
      repo.findById.mockResolvedValue(makeDriver({ deletedAt: new Date() }) as never);
      await expect(service.get('drv_1')).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND' });
    });
  });

  describe('B-100 — field-level 409s, phone / licence uniqueness, unit assignment on create', () => {
    const p2002 = (target: string[] | string) => Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target } });
    const vehicle = (overrides: Record<string, unknown> = {}) => ({ id: 'veh_1', status: 'ACTIVE', deletedAt: null, driver: null, ...overrides });

    beforeEach(() => {
      repo.findByUsername.mockResolvedValue(null);
      repo.create.mockResolvedValue(makeDriver() as never);
      repo.createWithVehicle.mockResolvedValue(makeDriver({ assignedVehicleId: 'veh_1' }) as never);
      repo.findById.mockResolvedValue(makeDriver() as never);
      repo.update.mockResolvedValue(makeDriver() as never);
    });

    it('rejects a phone another live driver has, compared on digits (+1 dropped)', async () => {
      repo.findLiveIdByPhoneKey.mockImplementation((key) => Promise.resolve(key === '6145551000' ? 'drv_2' : null));
      await expect(service.create({ ...baseDto, phone: '+1 (614) 555-1000' })).rejects.toMatchObject(TAKEN.phone);
      await expect(service.create({ ...baseDto, phone: '614.555.1000' })).rejects.toMatchObject(TAKEN.phone);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('allows a new phone and never checks an empty one', async () => {
      await service.create({ ...baseDto, phone: '+1 614 555 2000' });
      expect(repo.findLiveIdByPhoneKey).toHaveBeenCalledWith('6145552000', undefined);
      repo.findLiveIdByPhoneKey.mockClear();
      await service.create({ ...baseDto, phone: '  ' });
      expect(repo.findLiveIdByPhoneKey).not.toHaveBeenCalled();
    });

    it('rejects a licence number another live driver has, ignoring case / spaces / dashes', async () => {
      repo.findLiveIdByCdlKey.mockImplementation((key) => Promise.resolve(key === 'W8569238' ? 'drv_2' : null));
      await expect(service.create({ ...baseDto, cdlNumber: 'w 856-9238' })).rejects.toMatchObject(TAKEN.cdlNumber);
    });

    it('normalises email (trim + lower-case) before the check and the write', async () => {
      await service.create({ ...baseDto, email: ' JSmith@Example.com ' });
      expect(repo.findByEmail).toHaveBeenCalledWith('jsmith@example.com');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ email: 'jsmith@example.com' }));
    });

    it('update excludes the driver itself and rejects another driver\'s phone / licence', async () => {
      repo.findLiveIdByPhoneKey.mockResolvedValue('drv_2');
      await expect(service.update('drv_1', { phone: '6145551000' })).rejects.toMatchObject(TAKEN.phone);
      expect(repo.findLiveIdByPhoneKey).toHaveBeenCalledWith('6145551000', 'drv_1');
      repo.findLiveIdByPhoneKey.mockResolvedValue(null);
      repo.findLiveIdByCdlKey.mockResolvedValue('drv_2');
      await expect(service.update('drv_1', { cdlNumber: 'D-123' })).rejects.toMatchObject(TAKEN.cdlNumber);
      expect(repo.findLiveIdByCdlKey).toHaveBeenCalledWith('D123', 'drv_1');
      expect(repo.update).not.toHaveBeenCalled();
    });

    // CODE-010 — the edit form sends `null` for a phone / exemption reason the user emptied.
    it('update clears phone and ELD-exempt reason on null / blank', async () => {
      await service.update('drv_1', UpdateDriverDto.parse({ phone: null, eldExemptReason: null }));
      expect(repo.update).toHaveBeenCalledWith({ id: 'drv_1' }, expect.objectContaining({ phone: null, eldExemptReason: null }));
      repo.update.mockClear();
      await service.update('drv_1', UpdateDriverDto.parse({ phone: '  ' }));
      expect(repo.update).toHaveBeenCalledWith({ id: 'drv_1' }, expect.objectContaining({ phone: null }));
      expect(repo.findLiveIdByPhoneKey).not.toHaveBeenCalled();
    });

    it('update saving its own values succeeds (lookups exclude the driver itself)', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);
      await service.update('drv_1', { email: 'jsmith@example.com', phone: '6145551000', cdlNumber: 'D1234567' });
      expect(repo.update).toHaveBeenCalled();
    });

    it('assigns a free unit on create in one transactional write', async () => {
      repo.findVehicleForAssignment.mockResolvedValue(vehicle() as never);
      await service.create({ ...baseDto, assignedVehicleId: 'veh_1' });
      expect(repo.createWithVehicle).toHaveBeenCalledWith(expect.objectContaining({ username: 'jsmith' }), 'veh_1');
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects a unit another live driver has with VEHICLE_ALREADY_ASSIGNED and never takes it', async () => {
      repo.findVehicleForAssignment.mockResolvedValue(vehicle({ driver: { id: 'drv_2', deletedAt: null } }) as never);
      await expect(service.create({ ...baseDto, assignedVehicleId: 'veh_1' })).rejects.toMatchObject(TAKEN.assignedVehicleId);
      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.createWithVehicle).not.toHaveBeenCalled();
    });

    it('CODE-043 — rejects an INACTIVE unit like assign-driver does', async () => {
      repo.findVehicleForAssignment.mockResolvedValue(vehicle({ status: 'INACTIVE' }) as never);
      await expect(service.create({ ...baseDto, assignedVehicleId: 'veh_1' })).rejects.toMatchObject({ status: 409 });
      expect(repo.createWithVehicle).not.toHaveBeenCalled();
    });

    it('rejects an out-of-service or unknown unit', async () => {
      repo.findVehicleForAssignment.mockResolvedValue(vehicle({ status: 'OUT_OF_SERVICE' }) as never);
      await expect(service.create({ ...baseDto, assignedVehicleId: 'veh_1' })).rejects.toMatchObject({ code: 'VEHICLE_OUT_OF_SERVICE', status: 409 });
      repo.findVehicleForAssignment.mockResolvedValue(null);
      await expect(service.create({ ...baseDto, assignedVehicleId: 'veh_x' })).rejects.toMatchObject({
        code: 'VEHICLE_NOT_FOUND',
        status: 404,
        details: { assignedVehicleId: 'Select a unit.' },
      });
    });

    it.each([
      ['Driver_username_live_key', 'username'],
      [['email'], 'email'],
      ['Driver_email_live_key', 'email'],
      [['CASE', 'WHEN length(regexp_replace(phone'], 'phone'],
      [['upper(regexp_replace(cdlNumber'], 'cdlNumber'],
      [['assignedVehicleId'], 'assignedVehicleId'],
      ['Driver_assignedVehicleId_key', 'assignedVehicleId'],
    ] as const)('maps a racing P2002 on %j to the %s field', async (target, field) => {
      repo.create.mockRejectedValue(p2002(target as string[] | string));
      await expect(service.create(baseDto)).rejects.toMatchObject(TAKEN[field]);
    });

    it('importMany reports the field-level message per row and checks phone / licence on update rows', async () => {
      repo.findLiveIdByCdlKey.mockResolvedValueOnce('drv_9');
      repo.findByUsername.mockResolvedValueOnce(null).mockResolvedValueOnce(makeDriver({ id: 'drv_5' }) as never);
      repo.findLiveIdByPhoneKey.mockResolvedValueOnce('drv_9');
      const summary = await service.importMany({
        drivers: [
          { ...baseDto, username: 'new1' },
          { ...baseDto, username: 'jsmith', phone: '6145551000' },
        ],
      });
      expect(summary.failed).toEqual([
        { index: 0, error: 'A driver with this licence number already exists.' },
        { index: 1, error: 'A driver with this phone number already exists.' },
      ]);
      expect(repo.findLiveIdByPhoneKey).toHaveBeenCalledWith('6145551000', 'drv_5');
    });
  });

  describe('resetPassword (B-81)', () => {
    it('emails the new code when the driver has an email on file', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);
      repo.update.mockResolvedValue(makeDriver() as never);

      const result = await service.resetPassword('drv_1');

      expect(result.emailedTo).toBe('jsmith@example.com');
      expect(mail.send).toHaveBeenCalledTimes(1);
      // B-094 — the old refresh tokens die with the old password.
      expect(repo.revokeAllSessions).toHaveBeenCalledWith('drv_1');
      const anyString: unknown = expect.any(String);
      expect(repo.update).toHaveBeenCalledWith({ id: 'drv_1' }, expect.objectContaining({ passwordHash: anyString }));
    });

    it('returns a dispatcher-readable code and no email when there is none on file', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: null }) as never);
      repo.update.mockResolvedValue(makeDriver() as never);

      const result = await service.resetPassword('drv_1');

      expect(result.emailedTo).toBeNull();
      expect(result.code).toMatch(/^\d{6}$/);
      expect(mail.send).not.toHaveBeenCalled();
      expect(repo.revokeAllSessions).toHaveBeenCalledWith('drv_1');
    });

    it('B-093 — never echoes an emailed code when echoOneTimeSecrets is off', async () => {
      config = makeConfig(false);
      service = build(config);
      repo.findById.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);
      repo.update.mockResolvedValue(makeDriver() as never);

      const result = await service.resetPassword('drv_1');

      expect(result).toEqual({ emailedTo: 'jsmith@example.com' });
    });
  });

  describe('email verification (B-29/B-30/B-31)', () => {
    it('sendVerification rejects a driver without an email', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: null }) as never);
      await expect(service.sendVerification('drv_1')).rejects.toThrow(AppException);
    });

    it('sendVerification signs and emails a token', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);
      tokens.signDriverEmailVerifyToken.mockReturnValue('signed-token');

      const result = await service.sendVerification('drv_1');

      expect(tokens.signDriverEmailVerifyToken).toHaveBeenCalledWith('drv_1', 'jsmith@example.com');
      expect(result.emailedTo).toBe('jsmith@example.com');
      expect(mail.send).toHaveBeenCalledTimes(1);
      // A link to the public web page — never the bare token as the mail body.
      const text = mail.send.mock.calls[0][0].text;
      expect(text).toContain('https://web.example/driver-email/verify?token=signed-token');
      expect(text).not.toMatch(/Verification token:/);
    });

    it('sendVerification echoes the token as `code` only with DEV_ECHO_SECRETS', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);
      tokens.signDriverEmailVerifyToken.mockReturnValue('signed-token');
      expect(await build(makeConfig(false)).sendVerification('drv_1')).toEqual({ emailedTo: 'jsmith@example.com' });
      expect(await build(makeConfig(true)).sendVerification('drv_1')).toEqual({ emailedTo: 'jsmith@example.com', code: 'signed-token' });
    });

    describe('verifyEmailFromLink (public POST /auth/driver/email/verify)', () => {
      it('takes the driver from the token, sets emailVerifiedAt atomically and audits it', async () => {
        tokens.verifyDriverEmailVerifyToken.mockReturnValue({ driverId: 'drv_1', email: 'jsmith@example.com' });
        repo.findById
          .mockResolvedValueOnce(makeDriver({ email: 'jsmith@example.com', emailVerifiedAt: null }) as never)
          .mockResolvedValueOnce(makeDriver({ email: 'jsmith@example.com', emailVerifiedAt: new Date() }) as never);
        repo.updateIfState.mockResolvedValue(true);

        await expect(emailChange.verifyEmailFromLink('tok')).resolves.toEqual({ success: true, email: 'jsmith@example.com', alreadyVerified: false });
        const anyDate: unknown = expect.any(Date);
        expect(repo.findById).toHaveBeenCalledWith({ id: 'drv_1' });
        expect(repo.updateIfState).toHaveBeenCalledWith('drv_1', { email: 'jsmith@example.com', emailVerifiedAt: null }, { emailVerifiedAt: anyDate });
        expect(events.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'VERIFY_EMAIL', objectId: 'drv_1' }));
      });

      it('a repeat click reports alreadyVerified and writes nothing', async () => {
        tokens.verifyDriverEmailVerifyToken.mockReturnValue({ driverId: 'drv_1', email: 'jsmith@example.com' });
        repo.findById.mockResolvedValue(makeDriver({ email: 'jsmith@example.com', emailVerifiedAt: new Date() }) as never);
        await expect(emailChange.verifyEmailFromLink('tok')).resolves.toMatchObject({ alreadyVerified: true });
        expect(repo.updateIfState).not.toHaveBeenCalled();
      });

      it('a link for an address the driver no longer has (or a deleted driver) is TOKEN_INVALID', async () => {
        tokens.verifyDriverEmailVerifyToken.mockReturnValue({ driverId: 'drv_1', email: 'stale@example.com' });
        repo.findById.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);
        await expect(emailChange.verifyEmailFromLink('tok')).rejects.toMatchObject({ code: 'TOKEN_INVALID', status: 401 });
        repo.findById.mockResolvedValue(makeDriver({ email: 'stale@example.com', deletedAt: new Date() }) as never);
        await expect(emailChange.verifyEmailFromLink('tok')).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
        expect(repo.updateIfState).not.toHaveBeenCalled();
      });

      it('an expired / wrong-typ token propagates the TokenService error', async () => {
        tokens.verifyDriverEmailVerifyToken.mockImplementation(() => {
          throw new AppException('TOKEN_EXPIRED', 'Token expired.', 401);
        });
        await expect(emailChange.verifyEmailFromLink('tok')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
      });
    });

    it('verifyEmail sets emailVerifiedAt when the token matches', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);
      tokens.verifyDriverEmailVerifyToken.mockReturnValue({ driverId: 'drv_1', email: 'jsmith@example.com' });
      repo.update.mockResolvedValue(makeDriver({ email: 'jsmith@example.com', emailVerifiedAt: new Date() }) as never);

      await service.verifyEmail('drv_1', { token: 'tok' });

      const anyDate: unknown = expect.any(Date);
      expect(repo.update).toHaveBeenCalledWith({ id: 'drv_1' }, { emailVerifiedAt: anyDate });
    });

    it('verifyEmail rejects a token issued for a different email', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);
      tokens.verifyDriverEmailVerifyToken.mockReturnValue({ driverId: 'drv_1', email: 'stale@example.com' });

      await expect(service.verifyEmail('drv_1', { token: 'tok' })).rejects.toThrow(AppException);
    });
  });

  describe('documents (B-94)', () => {
    it('createDocument presigns a PUT and stores metadata', async () => {
      repo.findById.mockResolvedValue(makeDriver() as never);
      repo.createDocument.mockResolvedValue({
        id: 'doc_1',
        driverId: 'drv_1',
        type: 'CDL',
        fileName: 'front.jpg',
        fileKey: 'driver-documents/drv_1/abc-front.jpg',
        expiresAt: null,
        uploadedById: null,
        createdAt: new Date('2026-09-24T00:00:00.000Z'),
      });

      const result = await service.createDocument('drv_1', { type: 'CDL', fileName: '../../avatars/x/evil.html', contentType: 'image/jpeg', sizeBytes: 2048 });

      // B-091 — server-generated key (caller fileName never reaches it), content-type and
      // exact size bound into the PUT signature, 15-minute TTL.
      expect(storage.presignPut).toHaveBeenCalledWith(expect.stringMatching(/^driver-documents\/drv_1\/[0-9a-f]{32}\.jpg$/), 'image/jpeg', 900, 2048);
      expect(repo.createDocument).toHaveBeenCalledWith(expect.objectContaining({ fileName: '../../avatars/x/evil.html' }));
      expect(result.uploadUrl).toBe('https://minio/put');
      expect(result.url).toBe('https://minio/get');
    });

    it('B-091 — CreateDriverDocumentDto refuses active-content MIME types, missing size and oversize files', () => {
      const base = { type: 'CDL', fileName: 'cdl.pdf', contentType: 'application/pdf', sizeBytes: 1024 };
      expect(CreateDriverDocumentDto.safeParse(base).success).toBe(true);
      expect(CreateDriverDocumentDto.safeParse({ ...base, contentType: 'text/html' }).success).toBe(false);
      expect(CreateDriverDocumentDto.safeParse({ ...base, contentType: 'image/svg+xml' }).success).toBe(false);
      expect(CreateDriverDocumentDto.safeParse({ ...base, sizeBytes: undefined }).success).toBe(false);
      expect(CreateDriverDocumentDto.safeParse({ ...base, sizeBytes: 10 * 1024 * 1024 + 1 }).success).toBe(false);
    });

    it('deleteDocument rejects a document belonging to another driver', async () => {
      repo.findById.mockResolvedValue(makeDriver() as never);
      repo.findDocument.mockResolvedValue({ id: 'doc_1', driverId: 'drv_OTHER', fileKey: 'k' } as never);

      await expect(service.deleteDocument('drv_1', 'doc_1')).rejects.toThrow(AppException);
      expect(repo.deleteDocument).not.toHaveBeenCalled();
    });
  });

  describe('UI-005 — hosRuleset defaults to the carrier ruleset', () => {
    const { hosRuleset: _ruleset, ...noRuleset } = baseDto;
    const withCarrier = (hosRuleset: string | null) =>
      build(config, { get: jest.fn().mockResolvedValue(hosRuleset ? { hosRuleset } : null) });
    const createdRuleset = (call = 0) => (repo.create.mock.calls[call] as [{ hosRuleset?: string }])[0].hosRuleset;

    beforeEach(() => {
      repo.create.mockResolvedValue(makeDriver() as never);
    });

    it('the DTO no longer invents US_70_8_PROPERTY', () => {
      expect(CreateDriverDto.parse(noRuleset).hosRuleset).toBeUndefined();
      expect(CreateDriverDto.parse(baseDto).hosRuleset).toBe('US_70_8_PROPERTY');
    });

    it('create without hosRuleset takes the carrier ruleset', async () => {
      await withCarrier('US_60_7_PASSENGER').create(noRuleset);
      expect(createdRuleset()).toBe('US_60_7_PASSENGER');
    });

    it('an explicit hosRuleset wins over the carrier one', async () => {
      await withCarrier('US_60_7_PASSENGER').create({ ...baseDto, hosRuleset: 'US_70_8_PASSENGER' } as never);
      expect(createdRuleset()).toBe('US_70_8_PASSENGER');
    });

    it('no carrier row ⇒ undefined ⇒ the column default', async () => {
      await withCarrier(null).create(noRuleset);
      expect(createdRuleset()).toBeUndefined();
    });

    it('import: new rows take the carrier ruleset; an updated row keeps its own (no overwrite)', async () => {
      repo.findByUsername.mockResolvedValueOnce(null).mockResolvedValueOnce(makeDriver() as never);
      repo.update.mockResolvedValue(makeDriver() as never);
      await withCarrier('US_60_7_PROPERTY').importMany({ drivers: [{ ...noRuleset, username: 'new1' }, noRuleset] as never });
      expect(createdRuleset()).toBe('US_60_7_PROPERTY');
      const [, updateArg] = repo.update.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(updateArg).not.toHaveProperty('hosRuleset');
    });
  });

  describe('importMany', () => {
    it('creates new rows and updates existing ones by username (no options = prior behavior)', async () => {
      repo.findByUsername
        .mockResolvedValueOnce(null) // row 0: new
        .mockResolvedValueOnce(makeDriver() as never); // row 1: existing
      repo.create.mockResolvedValue(makeDriver() as never);
      repo.update.mockResolvedValue(makeDriver() as never);

      const summary = await service.importMany({ drivers: [baseDto, { ...baseDto, username: 'jsmith' }] });

      expect(summary).toEqual({ imported: 1, updated: 1, skipped: 0, failed: [] });
    });

    it('collects per-row failures instead of aborting the whole batch', async () => {
      repo.findByUsername.mockRejectedValue(new Error('db down'));

      const summary = await service.importMany({ drivers: [baseDto] });

      expect(summary.imported).toBe(0);
      expect(summary.failed).toEqual([{ index: 0, error: 'db down' }]);
    });

    it('a blank email cell imports the row with no email and no invitation', async () => {
      repo.findByUsername.mockResolvedValue(null);
      repo.create.mockImplementation(async (input) => makeDriver({ email: (input as { email?: string | null }).email ?? null }) as never);

      const dto = ImportDriversDto.parse({
        drivers: [{ ...baseDto, email: '' }, { ...baseDto, username: 'jdoe', email: '  ' }, { ...baseDto, username: 'kdoe', email: null }],
        options: { sendInvitations: true },
      });
      const summary = await service.importMany(dto);

      expect(summary).toEqual({ imported: 3, updated: 0, skipped: 0, failed: [] });
      for (const [arg] of repo.create.mock.calls as [{ email?: string | null }][]) expect(arg.email).toBeUndefined();
      expect(repo.findByEmail).not.toHaveBeenCalled();
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('B-69 duplicateStrategy SKIP leaves an existing row untouched', async () => {
      repo.findByUsername.mockResolvedValue(makeDriver() as never);

      const summary = await service.importMany({ drivers: [baseDto], options: { duplicateStrategy: 'SKIP', sendInvitations: false, applyDefaultExemptions: false } });

      expect(summary).toEqual({ imported: 0, updated: 0, skipped: 1, failed: [] });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('B-69 duplicateStrategy CREATE fails a known username instead of upserting', async () => {
      repo.findByUsername.mockResolvedValue(makeDriver() as never);

      const summary = await service.importMany({ drivers: [baseDto], options: { duplicateStrategy: 'CREATE', sendInvitations: false, applyDefaultExemptions: false } });

      expect(summary.failed).toHaveLength(1);
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('B-69 applyDefaultExemptions turns on the standard exception set for new rows', async () => {
      repo.findByUsername.mockResolvedValue(null);
      repo.create.mockResolvedValue(makeDriver() as never);

      await service.importMany({ drivers: [baseDto], options: { duplicateStrategy: 'UPDATE', applyDefaultExemptions: true, sendInvitations: false } });

      const [createArg] = repo.create.mock.calls[0] as [{ allowPersonalConveyance: boolean; allowYardMove: boolean }];
      expect(createArg.allowPersonalConveyance).toBe(true);
      expect(createArg.allowYardMove).toBe(true);
    });
  });

  describe('driver email change — pending + confirm + old-address cancel + hold + re-auth', () => {
    const actor = { id: 'usr_1', type: 'user' as const };
    const requestedAt = new Date('2026-10-13T10:00:00.000Z');
    const pendingDriver = (overrides: Record<string, unknown> = {}) =>
      makeDriver({
        email: 'old@example.com',
        emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        pendingEmail: 'new@example.com',
        pendingEmailRequestedAt: requestedAt,
        pendingEmailRequestedById: 'usr_1',
        ...overrides,
      });
    const mailTo = () => (mail.send.mock.calls as [{ to: string; text: string; subject: string }][]).map(([m]) => m);

    beforeEach(() => {
      repo.findById.mockResolvedValue(makeDriver({ email: 'old@example.com' }) as never);
      repo.update.mockImplementation((_where, data) =>
        Promise.resolve(makeDriver({ email: 'old@example.com', ...(data as object) }) as never),
      );
    });

    it('a changed email becomes pending: email is NOT written, links go to the new and old addresses', async () => {
      const result = await service.update('drv_1', { email: ' New@Example.com ', currentPassword: 'pw', firstName: 'Jo' }, actor);

      expect(auth.assertUserReauth).toHaveBeenCalledWith('usr_1', { currentPassword: 'pw', reauthIdToken: undefined });
      const [, data] = repo.update.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(data).not.toHaveProperty('email');
      expect(data).not.toHaveProperty('currentPassword');
      expect(data).toMatchObject({ firstName: 'Jo', pendingEmail: 'new@example.com', pendingEmailRequestedById: 'usr_1' });
      expect(result.email).toBe('old@example.com');
      expect(result.emailVerification).toEqual({ pendingEmail: 'new@example.com', emailDelivered: false, verifyToken: 'confirm-token' });

      const sent = mailTo();
      expect(sent.map((m) => m.to)).toEqual(['new@example.com', 'old@example.com']);
      expect(sent[0].text).toContain('https://web.example/driver-email/confirm?token=confirm-token');
      expect(sent[1].text).toContain('n***@e***.com');
      expect(sent[1].text).not.toContain('new@example.com');
      expect(sent[1].text).toContain('https://web.example/driver-email/cancel?token=cancel-token');
      expect(tokens.signDriverEmailChangeCancelToken).toHaveBeenCalledWith('drv_1', 'new@example.com', 'old@example.com', expect.any(Date));
      expect(events.publish).toHaveBeenCalledWith('audit.record', expect.objectContaining({ action: 'EMAIL_CHANGE_REQUEST', objectId: 'drv_1' }));
    });

    it('skips the old-address notice when the driver had no email', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: null }) as never);
      await service.update('drv_1', { email: 'new@example.com', currentPassword: 'pw' }, actor);
      expect(mailTo().map((m) => m.to)).toEqual(['new@example.com']);
    });

    describe('clearing the email (blank / null)', () => {
      it('needs re-auth, clears email + pending + verified, stamps changed, notifies the old address, audits', async () => {
        repo.findById.mockResolvedValue(pendingDriver() as never);
        repo.update.mockImplementation((_where, data) => Promise.resolve(pendingDriver(data as Record<string, unknown>) as never));

        const result = await service.update('drv_1', { email: '  ', currentPassword: 'pw', firstName: 'Jo' }, actor);

        expect(auth.assertUserReauth).toHaveBeenCalledWith('usr_1', { currentPassword: 'pw', reauthIdToken: undefined });
        const [, data] = repo.update.mock.calls[0] as [unknown, Record<string, unknown>];
        expect(data).toEqual({
          firstName: 'Jo',
          email: null,
          emailVerifiedAt: null,
          emailChangedAt: expect.any(Date) as unknown,
          previousEmail: 'old@example.com',
          pendingEmail: null,
          pendingEmailRequestedAt: null,
          pendingEmailRequestedById: null,
        });
        expect(result.email).toBeNull();
        expect(result).not.toHaveProperty('emailVerification');

        const sent = mailTo();
        expect(sent.map((m) => m.to)).toEqual(['old@example.com']);
        expect(sent[0].text).toContain('https://web.example/driver-email/cancel?token=cancel-token');
        expect(tokens.signDriverEmailChangeCancelToken).toHaveBeenCalledWith('drv_1', '', 'old@example.com', data.emailChangedAt);
        expect(events.publish).toHaveBeenCalledWith('audit.record', expect.objectContaining({ action: 'EMAIL_CHANGE_CLEAR', objectId: 'drv_1' }));
      });

      it('null clears too; without re-auth proof it is refused and nothing is written or mailed', async () => {
        auth.assertUserReauth.mockRejectedValue(new AppException('REAUTH_FAILED', 'Password is incorrect.', 401, { currentPassword: 'Password is incorrect.' }));
        await expect(service.update('drv_1', { email: null }, actor)).rejects.toMatchObject({ code: 'REAUTH_FAILED' });
        await expect(service.update('drv_1', { email: '' })).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
        expect(repo.update).not.toHaveBeenCalled();
        expect(mail.send).not.toHaveBeenCalled();
      });

      it('is refused inside the hold window of a previous change (EMAIL_CHANGE_ON_HOLD)', async () => {
        repo.findById.mockResolvedValue(makeDriver({ email: 'b@example.com', emailChangedAt: new Date(Date.now() - 3_600_000) }) as never);
        await expect(service.update('drv_1', { email: '', currentPassword: 'pw' }, actor)).rejects.toMatchObject({
          code: 'EMAIL_CHANGE_ON_HOLD',
          status: 409,
        });
        expect(repo.update).not.toHaveBeenCalled();
      });

      it('blank on a driver with no email, or email omitted, is a plain update: no re-auth, no mail', async () => {
        repo.findById.mockResolvedValue(makeDriver({ email: null }) as never);
        await service.update('drv_1', { email: '', firstName: 'Jo' }, actor);
        repo.findById.mockResolvedValue(makeDriver({ email: 'old@example.com' }) as never);
        await service.update('drv_1', { firstName: 'Jo' }, actor);

        expect(auth.assertUserReauth).not.toHaveBeenCalled();
        expect(mail.send).not.toHaveBeenCalled();
        for (const [, data] of repo.update.mock.calls as [unknown, Record<string, unknown>][]) {
          expect(data).toEqual({ firstName: 'Jo' });
        }
      });

      it('the old address\'s link restores a cleared email inside the hold', async () => {
        const changedAt = new Date(Date.now() - 3_600_000);
        repo.findById.mockResolvedValue(
          makeDriver({ email: null, previousEmail: 'old@example.com', emailChangedAt: changedAt }) as never,
        );
        tokens.verifyDriverEmailChangeCancelToken.mockReturnValue({
          driverId: 'drv_1',
          email: '',
          oldEmail: 'old@example.com',
          requestedAt: changedAt.getTime(),
        });
        await expect(emailChange.cancelFromLink('tok')).resolves.toEqual({ success: true, result: 'REVERTED' });
        expect(repo.updateIfState).toHaveBeenCalledWith(
          'drv_1',
          expect.objectContaining({ email: null, previousEmail: 'old@example.com' }),
          expect.objectContaining({ email: 'old@example.com', emailChangedAt: null, previousEmail: null }),
        );
      });
    });

    it('an unchanged email (after trim + lower-case) has no side effects and needs no password', async () => {
      const result = await service.update('drv_1', { email: '  OLD@example.com', firstName: 'Jo' }, actor);
      expect(auth.assertUserReauth).not.toHaveBeenCalled();
      expect(mail.send).not.toHaveBeenCalled();
      const [, data] = repo.update.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(data).toEqual({ firstName: 'Jo' });
      expect(result).not.toHaveProperty('emailVerification');
    });

    it('a wrong password is rejected and nothing is written or mailed', async () => {
      auth.assertUserReauth.mockRejectedValue(new AppException('REAUTH_FAILED', 'Password is incorrect.', 401, { currentPassword: 'Password is incorrect.' }));
      await expect(service.update('drv_1', { email: 'new@example.com', currentPassword: 'bad' }, actor)).rejects.toMatchObject({
        code: 'REAUTH_FAILED',
        status: 401,
      });
      expect(repo.update).not.toHaveBeenCalled();
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('only a signed-in web user may change it (API key / no actor → REAUTH_REQUIRED)', async () => {
      await expect(service.update('drv_1', { email: 'new@example.com' })).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
      await expect(
        service.update('drv_1', { email: 'new@example.com', currentPassword: 'pw' }, { id: 'key_1', type: 'api-key' }),
      ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('duplicate → 409 EMAIL_TAKEN: another live driver\'s email, or another driver\'s live pending change', async () => {
      repo.findByEmail.mockResolvedValueOnce(makeDriver({ id: 'drv_2', email: 'new@example.com' }) as never);
      await expect(service.update('drv_1', { email: 'new@example.com', currentPassword: 'pw' }, actor)).rejects.toMatchObject(TAKEN.email);
      repo.findLiveIdByPendingEmail.mockResolvedValueOnce('drv_3');
      await expect(service.update('drv_1', { email: 'new@example.com', currentPassword: 'pw' }, actor)).rejects.toMatchObject(TAKEN.email);
      expect(repo.findLiveIdByPendingEmail).toHaveBeenCalledWith('new@example.com', expect.any(Date), 'drv_1');
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('a new driver cannot take an address another driver has a live pending change to', async () => {
      repo.findByUsername.mockResolvedValue(null);
      repo.findLiveIdByPendingEmail.mockResolvedValueOnce('drv_3');
      await expect(service.create({ ...baseDto, email: 'new@example.com' })).rejects.toMatchObject(TAKEN.email);
    });

    it('a second change inside the hold window of the previous one is refused (EMAIL_CHANGE_ON_HOLD)', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: 'b@example.com', emailChangedAt: new Date(Date.now() - 3_600_000) }) as never);
      await expect(service.update('drv_1', { email: 'c@example.com', currentPassword: 'pw' }, actor)).rejects.toMatchObject({
        code: 'EMAIL_CHANGE_ON_HOLD',
        status: 409,
      });
      expect(auth.assertUserReauth).not.toHaveBeenCalled();
    });

    it('confirm swaps the email, stamps verified/changed, clears pending and revokes every session', async () => {
      repo.findById.mockResolvedValueOnce(pendingDriver() as never).mockResolvedValue(makeDriver({ email: 'new@example.com' }) as never);
      tokens.verifyDriverEmailChangeToken.mockReturnValue({ driverId: 'drv_1', email: 'new@example.com', requestedAt: requestedAt.getTime() });

      await expect(emailChange.confirm('tok')).resolves.toEqual({ success: true, email: 'new@example.com' });

      expect(repo.updateIfState).toHaveBeenCalledWith(
        'drv_1',
        { pendingEmail: 'new@example.com', pendingEmailRequestedAt: requestedAt },
        expect.objectContaining({
          email: 'new@example.com',
          previousEmail: 'old@example.com',
          emailVerifiedAt: expect.any(Date) as unknown,
          emailChangedAt: expect.any(Date) as unknown,
          pendingEmail: null,
          pendingEmailRequestedAt: null,
          pendingEmailRequestedById: null,
        }),
      );
      expect(repo.revokeAllSessions).toHaveBeenCalledWith('drv_1');
      expect(events.publish).toHaveBeenCalledWith('audit.record', expect.objectContaining({ action: 'EMAIL_CHANGE_CONFIRM', actorType: 'driver' }));
    });

    it('confirm refuses a superseded / cancelled link and a taken address', async () => {
      tokens.verifyDriverEmailChangeToken.mockReturnValue({ driverId: 'drv_1', email: 'new@example.com', requestedAt: requestedAt.getTime() - 1 });
      repo.findById.mockResolvedValue(pendingDriver() as never);
      await expect(emailChange.confirm('tok')).rejects.toMatchObject({ code: 'TOKEN_INVALID', status: 401 });
      repo.findById.mockResolvedValue(pendingDriver({ pendingEmail: null, pendingEmailRequestedAt: null }) as never);
      await expect(emailChange.confirm('tok')).rejects.toMatchObject({ code: 'TOKEN_INVALID' });

      tokens.verifyDriverEmailChangeToken.mockReturnValue({ driverId: 'drv_1', email: 'new@example.com', requestedAt: requestedAt.getTime() });
      repo.findById.mockResolvedValue(pendingDriver() as never);
      repo.findByEmail.mockResolvedValueOnce(makeDriver({ id: 'drv_2' }) as never);
      await expect(emailChange.confirm('tok')).rejects.toMatchObject(TAKEN.email);
      expect(repo.updateIfState).not.toHaveBeenCalled();
      expect(repo.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('"this wasn\'t me" from the old address cancels a pending change', async () => {
      repo.findById.mockResolvedValue(pendingDriver() as never);
      tokens.verifyDriverEmailChangeCancelToken.mockReturnValue({
        driverId: 'drv_1',
        email: 'new@example.com',
        oldEmail: 'old@example.com',
        requestedAt: requestedAt.getTime(),
      });
      await expect(emailChange.cancelFromLink('tok')).resolves.toEqual({ success: true, result: 'CANCELLED' });
      expect(repo.updateIfState).toHaveBeenCalledWith(
        'drv_1',
        { pendingEmail: 'new@example.com', pendingEmailRequestedAt: requestedAt },
        { pendingEmail: null, pendingEmailRequestedAt: null, pendingEmailRequestedById: null },
      );
      expect(repo.revokeAllSessions).not.toHaveBeenCalled();
      expect(events.publish).toHaveBeenCalledWith('audit.record', expect.objectContaining({ action: 'EMAIL_CHANGE_CANCEL' }));
    });

    it('inside the hold window the same link reverts a confirmed change and revokes sessions; after it, it is refused', async () => {
      const confirmed = (changedAgoMs: number) =>
        makeDriver({
          email: 'new@example.com',
          previousEmail: 'old@example.com',
          emailChangedAt: new Date(Date.now() - changedAgoMs),
          pendingEmail: null,
          pendingEmailRequestedAt: null,
        });
      tokens.verifyDriverEmailChangeCancelToken.mockReturnValue({
        driverId: 'drv_1',
        email: 'new@example.com',
        oldEmail: 'old@example.com',
        requestedAt: Date.now() - 5 * 3_600_000,
      });
      repo.findById.mockResolvedValue(confirmed(3_600_000) as never);

      await expect(emailChange.cancelFromLink('tok')).resolves.toEqual({ success: true, result: 'REVERTED' });
      expect(repo.updateIfState).toHaveBeenCalledWith(
        'drv_1',
        expect.objectContaining({ email: 'new@example.com', previousEmail: 'old@example.com' }),
        expect.objectContaining({ email: 'old@example.com', emailChangedAt: null, previousEmail: null }),
      );
      expect(repo.revokeAllSessions).toHaveBeenCalledWith('drv_1');
      expect(events.publish).toHaveBeenCalledWith('audit.record', expect.objectContaining({ action: 'EMAIL_CHANGE_REVERT' }));

      repo.updateIfState.mockClear();
      repo.findById.mockResolvedValue(confirmed(49 * 3_600_000) as never);
      tokens.verifyDriverEmailChangeCancelToken.mockReturnValue({
        driverId: 'drv_1',
        email: 'new@example.com',
        oldEmail: 'old@example.com',
        requestedAt: Date.now() - 50 * 3_600_000,
      });
      await expect(emailChange.cancelFromLink('tok')).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
      expect(repo.updateIfState).not.toHaveBeenCalled();
    });

    it('carrier reset during the hold never mails the new address: the code goes to the dispatcher', async () => {
      const changedAt = new Date(Date.now() - 3_600_000);
      repo.findById.mockResolvedValue(makeDriver({ email: 'new@example.com', emailChangedAt: changedAt }) as never);
      const result = await service.resetPassword('drv_1');
      expect(mail.send).not.toHaveBeenCalled();
      expect(result.emailedTo).toBeNull();
      expect(result.code).toMatch(/^\d{6}$/);
      expect(result.emailHoldUntil).toBe(new Date(changedAt.getTime() + 48 * 3_600_000).toISOString());
      expect(repo.revokeAllSessions).toHaveBeenCalledWith('drv_1');
    });

    it('resend re-mails the same request; cancelPending clears it; both 404 without a pending change', async () => {
      repo.findById.mockResolvedValue(pendingDriver() as never);
      await expect(emailChange.resend('drv_1')).resolves.toMatchObject({ pendingEmail: 'new@example.com', emailedTo: 'new@example.com' });
      expect(tokens.signDriverEmailChangeToken).toHaveBeenCalledWith('drv_1', 'new@example.com', requestedAt);
      expect(mailTo().map((m) => m.to)).toEqual(['new@example.com']);
      await emailChange.cancelPending('drv_1');
      expect(repo.updateIfState).toHaveBeenCalledWith('drv_1', expect.anything(), expect.objectContaining({ pendingEmail: null }));

      repo.findById.mockResolvedValue(makeDriver({ email: 'old@example.com' }) as never);
      await expect(emailChange.resend('drv_1')).rejects.toMatchObject({ code: 'EMAIL_CHANGE_NOT_PENDING', status: 404 });
      await expect(emailChange.cancelPending('drv_1')).rejects.toMatchObject({ code: 'EMAIL_CHANGE_NOT_PENDING' });
    });

    it('an import never changes an existing driver\'s email', async () => {
      repo.findByUsername.mockResolvedValue(makeDriver({ email: 'old@example.com' }) as never);
      await service.importMany({ drivers: [{ ...baseDto, email: 'new@example.com' }] });
      const [, data] = repo.update.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(data).not.toHaveProperty('email');
      expect(data).not.toHaveProperty('pendingEmail');
    });
  });
});
