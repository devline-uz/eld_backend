import { AppConfigService } from '../../core/config/config.service';
import { AppException } from '../../common/errors/app.exception';
import { IntegrationsRepository } from './integrations.repository';
import { IntegrationsService } from './integrations.service';
import { INTEGRATION_PROVIDERS } from './dto/integrations.dto';
import { IntegrationCipherService } from './lib/integration-cipher.service';

function makeCipher(): IntegrationCipherService {
  const config = { get: () => 'ZGV2LW9ubHktMzItYnl0ZS1rZXktY2hhbmdlLW1lISE=' } as unknown as AppConfigService;
  return new IntegrationCipherService(config);
}

function makeIntegration(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'int_1',
    provider: 'mcleod',
    enabled: true,
    config: { url: 'https://mcleod.example.com', apiKey: 'v1:iv:tag:ct' },
    status: 'CONNECTED',
    lastSyncAt: null,
    lastError: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('IntegrationsService', () => {
  let repo: jest.Mocked<Pick<IntegrationsRepository, 'list' | 'findByProvider' | 'findById' | 'upsert' | 'setStatus'>>;
  let service: IntegrationsService;
  const cipher = makeCipher();

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      findByProvider: jest.fn(),
      findById: jest.fn(),
      upsert: jest.fn(),
      setStatus: jest.fn(),
    };
    service = new IntegrationsService(repo as unknown as IntegrationsRepository, cipher);
  });

  it('list() never leaks a secret config field', async () => {
    repo.list.mockResolvedValue([makeIntegration({ config: { apiKey: cipher.encrypt('sk_live_123') } })] as never);

    const [view] = await service.list();

    expect(view.config.apiKey).toBe('[REDACTED]');
  });

  it('upsert() rejects an unknown provider', async () => {
    await expect(service.upsert('not-a-real-provider', { enabled: true, config: {} })).rejects.toThrow(AppException);
  });

  it.each(['pacific-track', 'dat', 'geotab', 'zapier'])('upsert() connects %s (W-22 marketplace provider)', async (provider) => {
    repo.upsert.mockResolvedValue(makeIntegration({ provider }) as never);

    await service.upsert(provider, { enabled: true, config: {} });

    expect(repo.upsert).toHaveBeenCalledWith(provider, expect.objectContaining({ enabled: true, status: 'CONNECTED' }));
  });

  it('upsert() encrypts secret-looking config fields before persisting', async () => {
    repo.upsert.mockResolvedValue(makeIntegration() as never);

    await service.upsert('mcleod', { enabled: true, config: { url: 'https://x.example.com', apiKey: 'sk_live_999' } });

    const [, data] = repo.upsert.mock.calls[0];
    expect(data.config).toMatchObject({ url: 'https://x.example.com' });
    expect((data.config as Record<string, unknown>).apiKey).not.toBe('sk_live_999');
    expect(String((data.config as Record<string, unknown>).apiKey)).toMatch(/^v1:/);
    expect(data.status).toBe('CONNECTED');
  });

  it('upsert() with enabled=false sets status DISCONNECTED', async () => {
    repo.upsert.mockResolvedValue(makeIntegration({ enabled: false, status: 'DISCONNECTED' }) as never);

    await service.upsert('slack', { enabled: false, config: {} });

    expect(repo.upsert.mock.calls[0][1].status).toBe('DISCONNECTED');
  });

  it('disconnect() 404s on an unconfigured provider', async () => {
    repo.findByProvider.mockResolvedValue(null);
    await expect(service.disconnect('mcleod')).rejects.toThrow(AppException);
  });

  it('disconnect() drops the stored config entirely', async () => {
    repo.findByProvider.mockResolvedValue(makeIntegration() as never);
    repo.upsert.mockResolvedValue(makeIntegration({ enabled: false, config: {}, status: 'DISCONNECTED' }) as never);

    await service.disconnect('mcleod');

    expect(repo.upsert).toHaveBeenCalledWith('mcleod', { enabled: false, config: {}, status: 'DISCONNECTED', lastError: null });
  });

  it('getDecryptedSecret() returns the real plaintext for internal callers only', async () => {
    repo.findByProvider.mockResolvedValue(makeIntegration({ config: { secret: cipher.encrypt('whsec_abc') } }) as never);

    const secret = await service.getDecryptedSecret('webhook', 'secret');

    expect(secret).toBe('whsec_abc');
  });

  it('getDecryptedSecret() throws INTEGRATION_NOT_CONFIGURED when disabled/missing', async () => {
    repo.findByProvider.mockResolvedValue(null);
    await expect(service.getDecryptedSecret('webhook', 'secret')).rejects.toThrow(AppException);

    repo.findByProvider.mockResolvedValue(makeIntegration({ enabled: false }) as never);
    await expect(service.getDecryptedSecret('webhook', 'secret')).rejects.toThrow(AppException);
  });

  it('get() returns the redacted view when configured', async () => {
    repo.findByProvider.mockResolvedValue(makeIntegration() as never);
    const view = await service.get('mcleod');
    expect(view.provider).toBe('mcleod');
  });

  it('get() 404s when the provider is unconfigured', async () => {
    repo.findByProvider.mockResolvedValue(null);
    await expect(service.get('mcleod')).rejects.toThrow(AppException);
  });

  it('markError() sets status ERROR with the message', async () => {
    repo.setStatus.mockResolvedValue(makeIntegration({ status: 'ERROR' }) as never);
    await service.markError('mcleod', 'timeout');
    expect(repo.setStatus).toHaveBeenCalledWith('mcleod', 'ERROR', 'timeout');
  });

  it('markSynced() sets status CONNECTED with lastSyncAt', async () => {
    repo.setStatus.mockResolvedValue(makeIntegration() as never);
    await service.markSynced('mcleod');
    expect(repo.setStatus).toHaveBeenCalledWith('mcleod', 'CONNECTED', null, expect.any(Date));
  });

  it('findEnabledByProvider() returns null when disabled', async () => {
    repo.findByProvider.mockResolvedValue(makeIntegration({ enabled: false }) as never);
    const result = await service.findEnabledByProvider('mcleod');
    expect(result).toBeNull();
  });

  it('findEnabledByProvider() returns the raw row when enabled', async () => {
    repo.findByProvider.mockResolvedValue(makeIntegration() as never);
    const result = await service.findEnabledByProvider('mcleod');
    expect(result?.provider).toBe('mcleod');
  });

  it('getRedactedSnapshot() returns null when the provider is unconfigured', async () => {
    repo.findByProvider.mockResolvedValue(null);
    const snapshot = await service.getRedactedSnapshot('mcleod');
    expect(snapshot).toBeNull();
  });

  it('getRedactedSnapshot() (used by the audit interceptor) never carries the ciphertext', async () => {
    repo.findByProvider.mockResolvedValue(makeIntegration({ config: { apiKey: cipher.encrypt('sk_live_123') } }) as never);

    const snapshot = await service.getRedactedSnapshot('mcleod');

    expect((snapshot?.config as Record<string, unknown>).apiKey).toBe('[REDACTED]');
  });

  describe('catalog (B-89)', () => {
    it('lists every catalog entry, connected providers available:true', () => {
      const entry = service.catalog().find((e) => e.provider === 'mcleod');
      expect(entry?.available).toBe(true);
    });

    it('lists Pacific Track, DAT, Geotab and Zapier as connectable (available:true)', () => {
      const catalog = service.catalog();
      for (const provider of ['pacific-track', 'dat', 'geotab', 'zapier']) {
        expect(catalog.find((e) => e.provider === provider)?.available).toBe(true);
      }
    });

    it('every catalog entry is an accepted provider, and every provider is in the catalog', () => {
      expect(service.catalog().map((e) => e.provider).sort()).toEqual([...INTEGRATION_PROVIDERS].sort());
    });
  });
});
