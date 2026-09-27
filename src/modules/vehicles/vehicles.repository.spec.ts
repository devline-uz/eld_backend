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

  it('findByUnitNumber queries live (non-deleted) units by unitNumber', async () => {
    vehicle.findFirst.mockResolvedValue({ id: 'v1' });
    const result = await repo.findByUnitNumber('101');
    expect(vehicle.findFirst).toHaveBeenCalledWith({ where: { unitNumber: '101', deletedAt: null } });
    expect(result).toEqual({ id: 'v1' });
  });

  it('findByVin queries live (non-deleted) units by vin', async () => {
    await repo.findByVin('VIN123');
    expect(vehicle.findFirst).toHaveBeenCalledWith({ where: { vin: 'VIN123', deletedAt: null } });
  });

  it('list builds a status + free-text filter and paginates', async () => {
    vehicle.findMany.mockResolvedValue([{ id: 'v1' }]);
    vehicle.count.mockResolvedValue(1);
    const result = await repo.list({ status: 'ACTIVE', q: 'ford' }, 2, 10, { unitNumber: 'asc' });
    expect(vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10, orderBy: { unitNumber: 'asc' } }),
    );
    const where = (vehicle.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where.status).toBe('ACTIVE');
    expect(where.deletedAt).toBeNull();
    expect(where.OR).toEqual(
      expect.arrayContaining([{ unitNumber: { contains: 'ford', mode: 'insensitive' } }]),
    );
    expect(result).toEqual({ items: [{ id: 'v1' }], total: 1 });
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

  it('findOpenCriticalDefectIds queries the Defect table for OPEN + CRITICAL rows on this unit', async () => {
    defect.findMany.mockResolvedValue([{ id: 'def_1' }]);
    const result = await repo.findOpenCriticalDefectIds('v1');
    expect(defect.findMany).toHaveBeenCalledWith({
      where: { vehicleId: 'v1', status: 'OPEN', severity: 'CRITICAL' },
      select: { id: true },
    });
    expect(result).toEqual([{ id: 'def_1' }]);
  });
});
