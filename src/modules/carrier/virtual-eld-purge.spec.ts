/** pt30_pt40/tz.md §9.5 — virtual-only purge, never RODS. */
import { parsePurgeArgs, purgeVirtualEldData } from './virtual-eld-purge';

function client(ids: string[]) {
  const prisma = {
    device: {
      findMany: jest.fn(async () => ids.map((id) => ({ id }))),
      count: jest.fn(async () => 1),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    deviceRawEvent: { count: jest.fn(async () => 5), deleteMany: jest.fn(async () => ({ count: 5 })) },
    telemetryPoint: { count: jest.fn(async () => 7), deleteMany: jest.fn(async () => ({ count: 7 })) },
    eldEvent: { deleteMany: jest.fn() },
    $transaction: jest.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };
  return prisma;
}

describe('parsePurgeArgs', () => {
  it('parses --before and --dry-run', () => {
    expect(parsePurgeArgs(['--before=2026-10-01', '--dry-run'])).toEqual({ before: new Date('2026-10-01'), dryRun: true });
  });

  it.each([[[]], [['--before=nope']], [['--before=2999-01-01']]])('rejects %j', (argv) => {
    expect(() => parsePurgeArgs(argv)).toThrow();
  });
});

describe('purgeVirtualEldData', () => {
  const before = new Date('2026-10-01T00:00:00Z');

  it('selects virtual devices only and deletes raw events + telemetry of those, never EldEvent', async () => {
    const prisma = client(['dev-v1']);
    const result = await purgeVirtualEldData(prisma as never, before, false);
    expect(prisma.device.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ isVirtual: true }, { serial: { startsWith: 'V', mode: 'insensitive' } }] } }),
    );
    expect(prisma.deviceRawEvent.deleteMany).toHaveBeenCalledWith({ where: { deviceId: { in: ['dev-v1'] }, occurredAt: { lt: before } } });
    expect(prisma.telemetryPoint.deleteMany).toHaveBeenCalledWith({ where: { deviceId: { in: ['dev-v1'] }, time: { lt: before } } });
    expect(prisma.eldEvent.deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ virtualDevices: 1, rawEvents: 5, telemetryPoints: 7, bleStatesReset: 1, dryRun: false });
  });

  it('dry-run only counts', async () => {
    const prisma = client(['dev-v1']);
    const result = await purgeVirtualEldData(prisma as never, before, true);
    expect(prisma.deviceRawEvent.deleteMany).not.toHaveBeenCalled();
    expect(prisma.telemetryPoint.deleteMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rawEvents: 5, telemetryPoints: 7, dryRun: true });
  });

  it('no virtual devices -> touches nothing', async () => {
    const prisma = client([]);
    await expect(purgeVirtualEldData(prisma as never, before, false)).resolves.toMatchObject({ virtualDevices: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
