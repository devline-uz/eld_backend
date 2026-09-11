import { SupportRepository } from './support.repository';

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

describe('SupportRepository', () => {
  let supportTicket: ReturnType<typeof makeDelegate>;
  let feedback: { create: jest.Mock };
  let repo: SupportRepository;

  beforeEach(() => {
    supportTicket = makeDelegate();
    feedback = { create: jest.fn() };
    repo = new SupportRepository({ supportTicket, feedback } as never);
  });

  it('list builds status/priority/q filters and paginates', async () => {
    supportTicket.findMany.mockResolvedValue([{ id: 'tck_1' }]);
    supportTicket.count.mockResolvedValue(1);
    const result = await repo.list({ status: 'OPEN', priority: 'HIGH', q: 'device' }, 1, 25, { createdAt: 'desc' });
    const where = (supportTicket.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where.status).toBe('OPEN');
    expect(where.priority).toBe('HIGH');
    expect(where.OR).toEqual(expect.arrayContaining([{ subject: { contains: 'device', mode: 'insensitive' } }]));
    expect(result).toEqual({ items: [{ id: 'tck_1' }], total: 1 });
  });

  it('list omits optional filters when absent', async () => {
    await repo.list({}, 1, 25, { createdAt: 'desc' });
    const where = (supportTicket.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where.status).toBeUndefined();
    expect(where.priority).toBeUndefined();
    expect(where.OR).toBeUndefined();
  });

  it('createFeedback delegates to prisma.feedback.create', async () => {
    const data = { answers: {}, userId: 'usr_1' } as never;
    await repo.createFeedback(data);
    expect(feedback.create).toHaveBeenCalledWith({ data });
  });
});
