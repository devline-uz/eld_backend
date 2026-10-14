import { DEFAULT_ROLE_MATRIX } from '../roles/permission-matrix';
import type { RolesRepository } from '../roles/roles.repository';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { sha256 } from '../auth/lib/hash.util';
import { ApiKeysRepository, ApiKeyWithCreator } from './api-keys.repository';
import { ApiKeysService } from './api-keys.service';

function makeKey(overrides: Partial<ApiKeyWithCreator> = {}): ApiKeyWithCreator {
  return {
    id: 'key_1',
    name: 'CI runner',
    keyHash: sha256('obk_plaintext'),
    prefix: 'obk_plai',
    scopes: ['reports'],
    createdById: 'usr_admin',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date(),
    createdBy: { status: 'ACTIVE', role: { key: 'ADMIN', permissions: DEFAULT_ROLE_MATRIX.ADMIN } },
    ...overrides,
  };
}

/**
 * TZ §6.5 — hashed storage, prefix display, scoped/expirable/revocable API keys.
 * Covers bugs.md B-010: revoked vs expired vs unknown must map to three distinct,
 * stable §20 codes, not collapse into one.
 */
/** Actor ids resolve to the role they hold (`RolesRepository.findRoleOfUser`). */
const HELD_ROLES: Record<string, { id: string; key: string; permissions: object }> = {
  usr_admin: { id: 'r_ADMIN', key: 'ADMIN', permissions: DEFAULT_ROLE_MATRIX.ADMIN },
  usr_sa: { id: 'r_SUPER_ADMIN', key: 'SUPER_ADMIN', permissions: DEFAULT_ROLE_MATRIX.SUPER_ADMIN },
  // A custom integrations manager: integrations:FULL, reports:READ, nothing else.
  usr_integrator: {
    id: 'r_integrator',
    key: 'INTEGRATOR',
    permissions: { ...DEFAULT_ROLE_MATRIX.VIEWER, integrations: 'FULL', reports: 'READ', users: 'NONE' },
  },
};
const ADMIN_ACTOR = { id: 'usr_admin' };

function makeRoles(): RolesRepository {
  return { findRoleOfUser: jest.fn(async (id: string) => HELD_ROLES[id] ?? null) } as unknown as RolesRepository;
}

describe('ApiKeysService', () => {
  function makeRepo(): jest.Mocked<ApiKeysRepository> {
    return {
      create: jest.fn(),
      list: jest.fn(),
      findById: jest.fn(),
      findByHash: jest.fn(),
      revoke: jest.fn(),
      touchLastUsed: jest.fn(),
      updateScopes: jest.fn(),
    } as unknown as jest.Mocked<ApiKeysRepository>;
  }

  describe('create', () => {
    it('returns the plaintext key exactly once and never persists it', async () => {
      const repo = makeRepo();
      repo.create.mockImplementation(async (input) =>
        makeKey({ keyHash: input.keyHash, prefix: input.prefix, scopes: input.scopes, name: input.name }),
      );
      const service = new ApiKeysService(repo, makeRoles());

      const { apiKey, plaintextKey } = await service.create(
        { name: 'CI runner', scopes: ['reports'] },
        ADMIN_ACTOR,
      );

      expect(plaintextKey).toMatch(/^obk_/);
      expect(repo.create).toHaveBeenCalledTimes(1);
      const persisted = repo.create.mock.calls[0][0];
      // The stored hash is derived from the plaintext, but the plaintext itself is
      // never in the persisted payload — only its SHA-256 digest and an 8-char prefix.
      expect(persisted.keyHash).toBe(sha256(plaintextKey));
      expect(persisted.keyHash).not.toBe(plaintextKey);
      expect(persisted.prefix).toBe(plaintextKey.slice(0, 8));
      expect(JSON.stringify(persisted)).not.toContain(plaintextKey.slice(4)); // no raw suffix leak
      // The response view never carries `keyHash`.
      expect(apiKey).not.toHaveProperty('keyHash');
    });
  });

  describe('verify', () => {
    it('rejects an unknown key with API_KEY_INVALID', async () => {
      const repo = makeRepo();
      repo.findByHash.mockResolvedValue(null);
      const service = new ApiKeysService(repo, makeRoles());

      try {
        await service.verify('obk_nope');
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).code).toBe(ERROR_CODES.API_KEY_INVALID);
      }
    });

    it('rejects a revoked key with API_KEY_REVOKED, distinct from an unknown key', async () => {
      const repo = makeRepo();
      repo.findByHash.mockResolvedValue(makeKey({ revokedAt: new Date() }));
      const service = new ApiKeysService(repo, makeRoles());

      try {
        await service.verify('obk_plaintext');
        throw new Error('expected to throw');
      } catch (err) {
        expect((err as AppException).code).toBe(ERROR_CODES.API_KEY_REVOKED);
      }
      expect(repo.touchLastUsed).not.toHaveBeenCalled();
    });

    it('rejects an expired key with API_KEY_EXPIRED, distinct from revoked', async () => {
      const repo = makeRepo();
      repo.findByHash.mockResolvedValue(makeKey({ expiresAt: new Date(Date.now() - 60_000) }));
      const service = new ApiKeysService(repo, makeRoles());

      try {
        await service.verify('obk_plaintext');
        throw new Error('expected to throw');
      } catch (err) {
        expect((err as AppException).code).toBe(ERROR_CODES.API_KEY_EXPIRED);
      }
      expect(repo.touchLastUsed).not.toHaveBeenCalled();
    });

    it('accepts an active, unexpired key and touches lastUsedAt', async () => {
      const repo = makeRepo();
      const key = makeKey();
      repo.findByHash.mockResolvedValue(key);
      repo.touchLastUsed.mockResolvedValue(key);
      const service = new ApiKeysService(repo, makeRoles());

      const result = await service.verify('obk_plaintext');

      expect(result.id).toBe('key_1');
      expect(repo.touchLastUsed).toHaveBeenCalledWith('key_1');
    });
  });

  describe('revoke', () => {
    it('404s on an unknown id', async () => {
      const repo = makeRepo();
      repo.findById.mockResolvedValue(null);
      const service = new ApiKeysService(repo, makeRoles());

      await expect(service.revoke('missing')).rejects.toThrow(AppException);
      expect(repo.revoke).not.toHaveBeenCalled();
    });

    it('is idempotent — revoking an already-revoked key does not re-write it', async () => {
      const repo = makeRepo();
      repo.findById.mockResolvedValue(makeKey({ revokedAt: new Date() }));
      const service = new ApiKeysService(repo, makeRoles());

      await service.revoke('key_1');

      expect(repo.revoke).not.toHaveBeenCalled();
    });

    it('revokes an active key', async () => {
      const repo = makeRepo();
      repo.findById.mockResolvedValue(makeKey());
      repo.revoke.mockResolvedValue(makeKey({ revokedAt: new Date() }));
      const service = new ApiKeysService(repo, makeRoles());

      await service.revoke('key_1');

      expect(repo.revoke).toHaveBeenCalledWith('key_1');
    });
  });

  describe('updateScopes', () => {
    it('404s on an unknown id', async () => {
      const repo = makeRepo();
      repo.findById.mockResolvedValue(null);
      const service = new ApiKeysService(repo, makeRoles());

      await expect(service.updateScopes('missing', ['reports'], ADMIN_ACTOR)).rejects.toThrow(AppException);
      expect(repo.updateScopes).not.toHaveBeenCalled();
    });

    it('replaces scopes and never returns keyHash', async () => {
      const repo = makeRepo();
      repo.findById.mockResolvedValue(makeKey());
      repo.updateScopes.mockResolvedValue(makeKey({ scopes: ['reports', 'trips'] }));
      const service = new ApiKeysService(repo, makeRoles());

      const view = await service.updateScopes('key_1', ['reports', 'trips'], ADMIN_ACTOR);

      expect(repo.updateScopes).toHaveBeenCalledWith('key_1', ['reports', 'trips']);
      expect(view.scopes).toEqual(['reports', 'trips']);
      expect(view).not.toHaveProperty('keyHash');
    });
  });

  /** CODE-003 — scopes are capped at the creator's own levels; keys die with their creator. */
  describe('permission ceiling (CODE-003)', () => {
    const INTEGRATOR = { id: 'usr_integrator' };

    it('rejects creating a key whose scopes exceed the creator (403, nothing persisted)', async () => {
      const repo = makeRepo();
      const service = new ApiKeysService(repo, makeRoles());

      const err = await service
        .create({ name: 'escalate', scopes: ['integrations:FULL', 'users:FULL', 'reports:FULL'] }, INTEGRATOR)
        .catch((e: unknown) => e);

      expect(err).toMatchObject({ code: 'FORBIDDEN', status: 403 });
      expect((err as Error).message).toContain('API key scopes cannot exceed your own permissions');
      expect((err as AppException).details).toEqual({
        exceeding: [
          { key: 'reports', requested: 'FULL', allowed: 'READ' },
          { key: 'users', requested: 'FULL', allowed: 'NONE' },
        ],
      });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('allows a key within the creator\u2019s levels and records the creator', async () => {
      const repo = makeRepo();
      repo.create.mockImplementation(async (input) => makeKey({ scopes: input.scopes, createdById: input.createdById }));
      const service = new ApiKeysService(repo, makeRoles());

      await service.create({ name: 'ok', scopes: ['integrations:full', 'reports:read'] }, INTEGRATOR);

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ createdById: 'usr_integrator' }));
    });

    it('rejects raising an existing key\u2019s scopes above the actor', async () => {
      const repo = makeRepo();
      repo.findById.mockResolvedValue(makeKey());
      const service = new ApiKeysService(repo, makeRoles());

      await expect(service.updateScopes('key_1', ['vehicles:FULL'], INTEGRATOR)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(repo.updateScopes).not.toHaveBeenCalled();
    });

    it('rejects an actor that cannot be resolved (disabled/missing user)', async () => {
      const repo = makeRepo();
      const service = new ApiKeysService(repo, makeRoles());

      await expect(service.create({ name: 'x', scopes: ['reports:read'] }, { id: 'usr_disabled' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('SUPER_ADMIN can still mint a key with every scope at FULL', async () => {
      const repo = makeRepo();
      repo.create.mockImplementation(async (input) => makeKey({ scopes: input.scopes }));
      const service = new ApiKeysService(repo, makeRoles());

      await service.create({ name: 'all', scopes: ['users:FULL', 'roles:FULL', 'integrations:FULL'] }, { id: 'usr_sa' });

      expect(repo.create).toHaveBeenCalled();
    });

    it.each(['DISABLED', 'INVITED'] as const)('rejects a key whose creator is %s, before touching lastUsedAt', async (status) => {
      const repo = makeRepo();
      repo.findByHash.mockResolvedValue(
        makeKey({ createdBy: { status, role: { key: 'ADMIN', permissions: DEFAULT_ROLE_MATRIX.ADMIN } } }),
      );
      const service = new ApiKeysService(repo, makeRoles());

      await expect(service.verify('obk_plaintext')).rejects.toMatchObject({
        code: ERROR_CODES.API_KEY_REVOKED,
        status: 401,
        message: 'API key owner is no longer active.',
      });
      expect(repo.touchLastUsed).not.toHaveBeenCalled();
    });
  });
});
