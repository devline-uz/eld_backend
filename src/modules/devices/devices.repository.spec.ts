import { DevicesRepository } from './devices.repository';

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

describe('DevicesRepository', () => {
  let device: ReturnType<typeof makeDelegate>;
  let repo: DevicesRepository;

  beforeEach(() => {
    device = makeDelegate();
    const prisma = { device } as never;
    repo = new DevicesRepository(prisma);
  });

  it('findBySerial queries by serial', async () => {
    await repo.findBySerial('PT30-001');
    expect(device.findUnique).toHaveBeenCalledWith({ where: { serial: 'PT30-001' } });
  });

  it('findByVehicleId queries by vehicleId', async () => {
    await repo.findByVehicleId('veh_1');
    expect(device.findUnique).toHaveBeenCalledWith({ where: { vehicleId: 'veh_1' } });
  });

  it('list builds status/bleState/q filters and paginates', async () => {
    device.findMany.mockResolvedValue([{ id: 'd1' }]);
    device.count.mockResolvedValue(1);
    const result = await repo.list(
      { status: 'ASSIGNED', bleState: 'CONNECTED', q: 'firmware-x' },
      1,
      25,
      { serial: 'asc' },
    );
    const where = (device.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where.status).toBe('ASSIGNED');
    expect(where.bleState).toBe('CONNECTED');
    expect(where.OR).toEqual(expect.arrayContaining([{ firmware: { contains: 'firmware-x', mode: 'insensitive' } }]));
    expect(result).toEqual({ items: [{ id: 'd1' }], total: 1 });
  });

  it('list omits optional filters when absent', async () => {
    await repo.list({}, 1, 20, { serial: 'asc' });
    const where = (device.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where.status).toEqual({ not: 'RETIRED' });
    expect(where.bleState).toBeUndefined();
    expect(where.OR).toBeUndefined();
  });

  it('listAll orders by serial', async () => {
    await repo.listAll();
    expect(device.findMany).toHaveBeenCalledWith({ orderBy: { serial: 'asc' } });
  });

  it('UI-012 — connectionCounts counts the non-retired inventory: effective CONNECTED and silent > 24 h', async () => {
    device.count.mockResolvedValueOnce(10).mockResolvedValueOnce(6).mockResolvedValueOnce(2);
    const since = new Date('2026-10-12T11:30:00Z');
    const before = new Date('2026-10-11T12:00:00Z');
    await expect(repo.connectionCounts(since, before)).resolves.toEqual({ total: 10, connected: 6, offlineOver24h: 2 });
    expect(device.count).toHaveBeenNthCalledWith(1, { where: { status: { not: 'RETIRED' } } });
    expect(device.count).toHaveBeenNthCalledWith(2, { where: { status: { not: 'RETIRED' }, bleState: 'CONNECTED', lastSeenAt: { gte: since } } });
    expect(device.count).toHaveBeenNthCalledWith(3, {
      where: { status: { not: 'RETIRED' }, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: before } }] },
    });
  });
});
