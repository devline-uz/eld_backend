import { DEFAULT_ROLE_MATRIX } from '../roles/permission-matrix';
import type { ApiKeyWithCreator } from './api-keys.repository';
import { ApiKeysAuthAdapter } from './api-keys-auth.adapter';
import { ApiKeysService } from './api-keys.service';

function makeKey(overrides: Partial<ApiKeyWithCreator> = {}): ApiKeyWithCreator {
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
    createdBy: { status: 'ACTIVE', role: { key: 'ADMIN', permissions: DEFAULT_ROLE_MATRIX.ADMIN } },
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

  it('caps the scope matrix at the creator\u2019s current role (CODE-003: pre-existing over-scoped keys)', async () => {
    const creatorRole = { key: 'INTEGRATOR', permissions: { ...DEFAULT_ROLE_MATRIX.VIEWER, integrations: 'FULL' } };
    const apiKeys = {
      verify: jest.fn().mockResolvedValue(
        makeKey({ scopes: ['users:full', 'reports:full', 'integrations:full'], createdBy: { status: 'ACTIVE', role: creatorRole } }),
      ),
    };
    const adapter = new ApiKeysAuthAdapter(apiKeys as unknown as ApiKeysService);

    const user = await adapter.verify('obk_plaintext');

    expect(user.permissions?.users).toBe('NONE');
    expect(user.permissions?.reports).toBe('READ');
    expect(user.permissions?.integrations).toBe('FULL');
  });

  it('does not cap a SUPER_ADMIN creator\u2019s key', async () => {
    const apiKeys = {
      verify: jest.fn().mockResolvedValue(
        makeKey({ scopes: ['dataTransfer:full'], createdBy: { status: 'ACTIVE', role: { key: 'SUPER_ADMIN', permissions: {} } } }),
      ),
    };
    const adapter = new ApiKeysAuthAdapter(apiKeys as unknown as ApiKeysService);

    expect((await adapter.verify('obk_plaintext')).permissions?.dataTransfer).toBe('FULL');
  });
});
