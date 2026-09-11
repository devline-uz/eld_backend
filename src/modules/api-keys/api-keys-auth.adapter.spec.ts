import type { ApiKey } from '@prisma/client';
import { ApiKeysAuthAdapter } from './api-keys-auth.adapter';
import { ApiKeysService } from './api-keys.service';

function makeKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key_1',
    name: 'CI runner',
    keyHash: 'hash',
    prefix: 'obk_ABCD',
    scopes: ['reports:read'],
    createdById: 'usr_1',
    createdAt: new Date(),
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe('ApiKeysAuthAdapter (TZ §6.5, §11.7 — API key "used" half)', () => {
  it('resolves a valid plaintext key into an api-key ContextUser with a scoped permission matrix', async () => {
    const apiKeys = { verify: jest.fn().mockResolvedValue(makeKey({ scopes: ['reports:read', 'integrations:full'] })) };
    const adapter = new ApiKeysAuthAdapter(apiKeys as unknown as ApiKeysService);

    const user = await adapter.verify('obk_plaintext');

    expect(apiKeys.verify).toHaveBeenCalledWith('obk_plaintext');
    expect(user).toMatchObject({ id: 'key_1', type: 'api-key' });
    expect(user.permissions?.reports).toBe('READ');
    expect(user.permissions?.integrations).toBe('FULL');
    expect(user.permissions?.vehicles).toBe('NONE');
  });

  it('propagates verify() failures (revoked/expired/invalid) unchanged', async () => {
    const err = new Error('revoked');
    const apiKeys = { verify: jest.fn().mockRejectedValue(err) };
    const adapter = new ApiKeysAuthAdapter(apiKeys as unknown as ApiKeysService);

    await expect(adapter.verify('obk_plaintext')).rejects.toBe(err);
  });

  it('ignores a malformed stored scope instead of throwing', async () => {
    const apiKeys = { verify: jest.fn().mockResolvedValue(makeKey({ scopes: ['garbage', 'reports:read'] })) };
    const adapter = new ApiKeysAuthAdapter(apiKeys as unknown as ApiKeysService);

    const user = await adapter.verify('obk_plaintext');

    expect(user.permissions?.reports).toBe('READ');
  });
});
