import { MessagingRepository } from './messaging.repository';

describe('MessagingRepository.createConversation (LIVE-026 — one 1:1 thread per pair)', () => {
  function build(existing: unknown) {
    const tx = {
      $executeRawUnsafe: jest.fn(async () => 0),
      conversation: {
        findFirst: jest.fn(async () => existing),
        create: jest.fn(async () => ({ id: 'cnv_new' })),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      conversation: { create: jest.fn(async () => ({ id: 'cnv_group' })) },
    };
    return { repo: new MessagingRepository(prisma as never), prisma, tx };
  }

  it('DIRECT: locks the pair and returns the thread another request created meanwhile', async () => {
    const { repo, tx } = build({ id: 'cnv_raced' });
    const out = await repo.createConversation({ type: 'DIRECT', createdById: 'usr_1' }, [{ userId: 'usr_1' }, { driverId: 'drv_1' }]);
    expect(out).toEqual({ id: 'cnv_raced' });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), 'dm:d:drv_1|u:usr_1');
    expect(tx.conversation.create).not.toHaveBeenCalled();
  });

  it('DIRECT: creates inside the lock when no thread exists', async () => {
    const { repo, tx } = build(null);
    const out = await repo.createConversation({ type: 'DIRECT', createdById: 'usr_1' }, [{ driverId: 'drv_1' }, { userId: 'usr_1' }]);
    expect(out).toEqual({ id: 'cnv_new' });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(expect.any(String), 'dm:d:drv_1|u:usr_1');
  });

  it('GROUP / BROADCAST are created directly, no lock', async () => {
    const { repo, prisma } = build(null);
    await repo.createConversation({ type: 'GROUP', createdById: 'usr_1' }, [{ userId: 'usr_1' }, { driverId: 'd1' }, { driverId: 'd2' }]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.conversation.create).toHaveBeenCalledTimes(1);
  });
});
