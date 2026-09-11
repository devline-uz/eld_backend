import { AppException } from '../../common/errors/app.exception';
import { DriversRepository } from './drivers.repository';
import { DriversService } from './drivers.service';

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
    ...overrides,
  };
}

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
};

describe('DriversService', () => {
  let repo: jest.Mocked<Pick<DriversRepository, 'findByUsername' | 'findById' | 'create' | 'update' | 'delete' | 'list' | 'listAll'>>;
  let service: DriversService;

  beforeEach(() => {
    repo = {
      findByUsername: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      list: jest.fn(),
      listAll: jest.fn(),
    };
    service = new DriversService(repo as unknown as DriversRepository);
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

  it('rejects a duplicate username', async () => {
    repo.findByUsername.mockResolvedValue(makeDriver() as never);

    await expect(service.create(baseDto)).rejects.toThrow(AppException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown driver id on update', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(service.update('missing', {})).rejects.toThrow(AppException);
  });

  it('remove() soft-deletes (status -> TERMINATED), never calls repo.delete (bugs.md B-009)', async () => {
    repo.findById.mockResolvedValue(makeDriver() as never);
    repo.update.mockResolvedValue(makeDriver({ status: 'TERMINATED' }) as never);

    await service.remove('drv_1');

    expect(repo.update).toHaveBeenCalledWith({ id: 'drv_1' }, { status: 'TERMINATED', assignedVehicle: { disconnect: true } });
    expect(repo.delete).not.toHaveBeenCalled();
  });

  describe('importMany', () => {
    it('creates new rows and updates existing ones by username', async () => {
      repo.findByUsername
        .mockResolvedValueOnce(null) // row 0: new
        .mockResolvedValueOnce(makeDriver() as never); // row 1: existing
      repo.create.mockResolvedValue(makeDriver() as never);
      repo.update.mockResolvedValue(makeDriver() as never);

      const summary = await service.importMany({ drivers: [baseDto, { ...baseDto, username: 'jsmith' }] });

      expect(summary).toEqual({ imported: 1, updated: 1, failed: [] });
    });

    it('collects per-row failures instead of aborting the whole batch', async () => {
      repo.findByUsername.mockRejectedValue(new Error('db down'));

      const summary = await service.importMany({ drivers: [baseDto] });

      expect(summary.imported).toBe(0);
      expect(summary.failed).toEqual([{ index: 0, error: 'db down' }]);
    });
  });
});
