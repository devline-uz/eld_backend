import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { ApiKey } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { sha256 } from '../auth/lib/hash.util';
import { CreateApiKeyDto } from './dto/api-keys.dto';
import { ApiKeysRepository } from './api-keys.repository';

const PREFIX_LEN = 8;

export type ApiKeyView = Omit<ApiKey, 'keyHash'>;

function toView(key: ApiKey): ApiKeyView {
  const { keyHash: _keyHash, ...view } = key;
  return view;
}

/**
 * TZ §6.5 — hashed storage, prefix display, scoped + expirable + revocable API keys.
 * Placed in its own `modules/api-keys` (not folded into `integrations`) because it is a
 * pure auth/authorization concern — the plaintext key is bearer-token-equivalent and its
 * lifecycle (issue/revoke) has nothing to do with third-party integration config.
 */
@Injectable()
export class ApiKeysService {
  constructor(private readonly repo: ApiKeysRepository) {}

  async list(): Promise<ApiKeyView[]> {
    return (await this.repo.list()).map(toView);
  }

  /** Plaintext key is returned exactly once, here, and never persisted. The stored
   * `keyHash` never appears in any response (TZ §6.5). */
  async create(dto: CreateApiKeyDto, createdById: string): Promise<{ apiKey: ApiKeyView; plaintextKey: string }> {
    const plaintextKey = `obk_${randomBytes(24).toString('base64url')}`;
    const prefix = plaintextKey.slice(0, PREFIX_LEN);
    const apiKey = await this.repo.create({
      name: dto.name,
      keyHash: sha256(plaintextKey),
      prefix,
      scopes: dto.scopes,
      createdById,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    });
    return { apiKey: toView(apiKey), plaintextKey };
  }

  async revoke(id: string): Promise<void> {
    const key = await this.repo.findById(id);
    if (!key) throw AppException.notFound('API key not found.');
    if (key.revokedAt) return;
    await this.repo.revoke(id);
  }

  /** TZ §6.5 — scope change is audited exactly like create/revoke; the plaintext key
   * and hash are never touched, only the `scopes` array. */
  async updateScopes(id: string, scopes: string[]): Promise<ApiKeyView> {
    const key = await this.repo.findById(id);
    if (!key) throw AppException.notFound('API key not found.');
    const updated = await this.repo.updateScopes(id, scopes);
    return toView(updated);
  }

  /**
   * Verifies a presented plaintext key against the stored hash (used by ingest/API-key auth).
   * Looked up by hash regardless of revoked/expired state so each failure mode gets its own
   * stable §20 code instead of collapsing "revoked" and "wrong key" into one API_KEY_INVALID —
   * see bugs.md B-010. A revoked or expired key is rejected here immediately: there is no
   * cache layer between this check and the DB, so a revoke is visible on the very next call.
   */
  async verify(plaintextKey: string): Promise<ApiKey> {
    const key = await this.repo.findByHash(sha256(plaintextKey));
    if (!key) throw new AppException(ERROR_CODES.API_KEY_INVALID, 'Invalid API key.', 401);
    if (key.revokedAt) throw new AppException(ERROR_CODES.API_KEY_REVOKED, 'API key has been revoked.', 401);
    if (key.expiresAt && key.expiresAt < new Date()) {
      throw new AppException(ERROR_CODES.API_KEY_EXPIRED, 'API key has expired.', 401);
    }
    await this.repo.touchLastUsed(key.id);
    return key;
  }
}
