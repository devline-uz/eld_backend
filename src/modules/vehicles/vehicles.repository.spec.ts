import { VehiclesRepository } from './vehicles.repository';

function makeDelegate() {
  return {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    groupBy: jest.fn().mockResolvedValue([]),
  };
}

describe('VehiclesRepository', () => {
  let vehicle: ReturnType<typeof makeDelegate>;
  let defect: { findMany: jest.Mock };
  let repo: VehiclesRepository;

  beforeEach(() => {
    vehicle = makeDelegate();
    defect = { findMany: jest.fn().mockResolvedValue([]) };
    const prisma = { vehicle, defect } as never;
    repo = new VehiclesRepository(prisma);
  });

  it('findByUnitNumber queries live units by unitNumber, ignoring the display # and case (B-97)', async () => {
    vehicle.findMany.mockResolvedValue([{ id: 'v1', unitNumber: '#101A' }]);
    const result = await repo.findByUnitNumber(' #101a ');
    expect(vehicle.findMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        OR: [
          { unitNumber: { equals: '101A', mode: 'insensitive' } },
          { unitNumber: { endsWith: '#101A', mode: 'insensitive' } },
        ],
      },
    });
    expect(result).toEqual({ id: 'v1', unitNumber: '#101A' });
  });

  it('BE-22 — findByUnitNumber strips every leading # (like the canonical DB index)', async () => {
    vehicle.findMany.mockResolvedValue([{ id: 'v7', unitNumber: '7' }, { id: 'vx', unitNumber: 'X#7' }]);
    expect(await repo.findByUnitNumber('##7')).toEqual({ id: 'v7', unitNumber: '7' });
    vehicle.findMany.mockResolvedValue([{ id: 'v77', unitNumber: '##7' }]);
    expect(await repo.findByUnitNumber('7')).toEqual({ id: 'v77', unitNumber: '##7' });
    vehicle.findMany.mockResolvedValue([{ id: 'vx', unitNumber: 'X#7' }]);
    expect(await repo.findByUnitNumber('7')).toBeNull();
  });

  it('findByVin queries live (non-deleted) units by vin, case-insensitively', async () => {
    await repo.findByVin('VIN123');
    expect(vehicle.findFirst).toHaveBeenCalledWith({ where: { vin: { equals: 'VIN123', mode: 'insensitive' }, deletedAt: null } });
  });

  it('list builds a status + free-text filter and paginates', async () => {
    vehicle.findMany.mockResolvedValue([{ id: 'v1', device: { serial: 'PT30_D3ED' } }, { id: 'v2', device: null }]);
    vehicle.count.mockResolvedValue(1);
    const result = await repo.list({ status: 'ACTIVE', q: 'ford' }, 2, 10, { unitNumber: 'asc' });
    expect(vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10, orderBy: { unitNumber: 'asc' } }),
    );
    const where = (vehicle.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where.status).toBe('ACTIVE');
    expect(where.deletedAt).toBeNull();
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { unitNumber: { contains: 'ford', mode: 'insensitive' } },
        // LIVE-022 — the ELD serial shown in the list is searchable.
        { device: { serial: { contains: 'ford', mode: 'insensitive' } } },
      ]),
    );
    // CODE-085 — the paired serial is flattened onto the row; the relation itself is not returned.
    expect(result).toEqual({ items: [{ id: 'v1', eldSerial: 'PT30_D3ED' }, { id: 'v2', eldSerial: null }], total: 1 });
  });

  it('BE-014 — list escapes LIKE wildcards so `%` / `_` search literally', async () => {
    await repo.list({ q: '50%_a\\b' }, 1, 20, { unitNumber: 'asc' });
    const where = (vehicle.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where.OR).toEqual(expect.arrayContaining([{ unitNumber: { contains: '50\\%\\_a\\\\b', mode: 'insensitive' } }]));
  });

  it('list omits status/q filters when not provided', async () => {
    await repo.list({}, 1, 20, { unitNumber: 'asc' });
    const where = (vehicle.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where.status).toBeUndefined();
    expect(where.OR).toBeUndefined();
  });

  it('listAll returns live units ordered by unitNumber', async () => {
    await repo.listAll();
    expect(vehicle.findMany).toHaveBeenCalledWith({ where: { deletedAt: null }, orderBy: { unitNumber: 'asc' } });
  });

  it('findOpenCriticalDefectIds queries the Defect table for CRITICAL rows still holding this unit (OPEN / IN_PROGRESS / DEFERRED — QA CODE-008)', async () => {
    defect.findMany.mockResolvedValue([{ id: 'def_1' }]);
    const result = await repo.findOpenCriticalDefectIds('v1');
    expect(defect.findMany).toHaveBeenCalledWith({
      where: {
        vehicleId: 'v1',
        status: { in: ['OPEN', 'IN_PROGRESS', 'DEFERRED'] },
        OR: [{ severity: 'CRITICAL' }, { outOfService: true }],
      },
      select: { id: true },
    });
    expect(result).toEqual([{ id: 'def_1' }]);
  });

  it('UI-004 — countByStatus groups live units by record status, zero-filled', async () => {
    vehicle.groupBy.mockResolvedValue([
      { status: 'ACTIVE', _count: { _all: 4 } },
      { status: 'OUT_OF_SERVICE', _count: { _all: 1 } },
    ]);
    await expect(repo.countByStatus()).resolves.toEqual({ ACTIVE: 4, INACTIVE: 0, OUT_OF_SERVICE: 1, total: 5 });
    expect(vehicle.groupBy).toHaveBeenCalledWith({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } });
  });
});
