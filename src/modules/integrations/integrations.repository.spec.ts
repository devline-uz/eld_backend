import { IntegrationsRepository } from './integrations.repository';

describe('IntegrationsRepository', () => {
  let integration: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
  };
  let repo: IntegrationsRepository;

  beforeEach(() => {
    integration = { findMany: jest.fn(), findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() };
    repo = new IntegrationsRepository({ integration } as never);
  });

  it('list orders by provider', async () => {
    await repo.list();
    expect(integration.findMany).toHaveBeenCalledWith({ orderBy: { provider: 'asc' } });
  });

  it('findByProvider queries by provider', async () => {
    await repo.findByProvider('mcleod');
    expect(integration.findUnique).toHaveBeenCalledWith({ where: { provider: 'mcleod' } });
  });

  it('findById queries by id', async () => {
    await repo.findById('int_1');
    expect(integration.findUnique).toHaveBeenCalledWith({ where: { id: 'int_1' } });
  });

  it('upsert creates on first write and updates thereafter', async () => {
    const data = { enabled: true, config: {}, status: 'CONNECTED' as const };
    await repo.upsert('mcleod', data);
    expect(integration.upsert).toHaveBeenCalledWith({
      where: { provider: 'mcleod' },
      create: { provider: 'mcleod', ...data },
      update: data,
    });
  });

  it('setStatus updates status/lastError, including lastSyncAt when given', async () => {
    const syncedAt = new Date();
    await repo.setStatus('mcleod', 'CONNECTED', null, syncedAt);
    expect(integration.update).toHaveBeenCalledWith({
      where: { provider: 'mcleod' },
      data: { status: 'CONNECTED', lastError: null, lastSyncAt: syncedAt },
    });
  });

  it('setStatus omits lastSyncAt when not given', async () => {
    await repo.setStatus('mcleod', 'ERROR', 'boom');
    expect(integration.update).toHaveBeenCalledWith({
      where: { provider: 'mcleod' },
      data: { status: 'ERROR', lastError: 'boom' },
    });
  });
});
