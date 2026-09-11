import type { ApiKey } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { sha256 } from '../auth/lib/hash.util';
import { ApiKeysRepository } from './api-keys.repository';
import { ApiKeysService } from './api-keys.service';

function makeKey(overrides: Partial<ApiKey> = {}): ApiKey {
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
    ...overrides,
  };
}

/**
 * TZ §6.5 — hashed storage, prefix display, scoped/expirable/revocable API keys.
 * Covers bugs.md B-010: revoked vs expired vs unknown must map to three distinct,
 * stable §20 codes, not collapse into one.
 */
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
      const service = new ApiKeysService(repo);

      const { apiKey, plaintextKey } = await service.create(
        { name: 'CI runner', scopes: ['reports'] },
        'usr_admin',
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
      const service = new ApiKeysService(repo);

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
      const service = new ApiKeysService(repo);

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
      const service = new ApiKeysService(repo);

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
      const service = new ApiKeysService(repo);

      const result = await service.verify('obk_plaintext');

      expect(result.id).toBe('key_1');
      expect(repo.touchLastUsed).toHaveBeenCalledWith('key_1');
    });
  });

  describe('revoke', () => {
    it('404s on an unknown id', async () => {
      const repo = makeRepo();
      repo.findById.mockResolvedValue(null);
      const service = new ApiKeysService(repo);

      await expect(service.revoke('missing')).rejects.toThrow(AppException);
      expect(repo.revoke).not.toHaveBeenCalled();
    });

    it('is idempotent — revoking an already-revoked key does not re-write it', async () => {
      const repo = makeRepo();
      repo.findById.mockResolvedValue(makeKey({ revokedAt: new Date() }));
      const service = new ApiKeysService(repo);

      await service.revoke('key_1');

      expect(repo.revoke).not.toHaveBeenCalled();
    });

    it('revokes an active key', async () => {
      const repo = makeRepo();
      repo.findById.mockResolvedValue(makeKey());
      repo.revoke.mockResolvedValue(makeKey({ revokedAt: new Date() }));
      const service = new ApiKeysService(repo);

      await service.revoke('key_1');

      expect(repo.revoke).toHaveBeenCalledWith('key_1');
    });
  });

  describe('updateScopes', () => {
    it('404s on an unknown id', async () => {
      const repo = makeRepo();
      repo.findById.mockResolvedValue(null);
      const service = new ApiKeysService(repo);

      await expect(service.updateScopes('missing', ['reports'])).rejects.toThrow(AppException);
      expect(repo.updateScopes).not.toHaveBeenCalled();
    });

    it('replaces scopes and never returns keyHash', async () => {
      const repo = makeRepo();
      repo.findById.mockResolvedValue(makeKey());
      repo.updateScopes.mockResolvedValue(makeKey({ scopes: ['reports', 'trips'] }));
      const service = new ApiKeysService(repo);

      const view = await service.updateScopes('key_1', ['reports', 'trips']);

      expect(repo.updateScopes).toHaveBeenCalledWith('key_1', ['reports', 'trips']);
      expect(view.scopes).toEqual(['reports', 'trips']);
      expect(view).not.toHaveProperty('keyHash');
    });
  });
});
