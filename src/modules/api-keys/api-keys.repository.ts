import { Injectable } from '@nestjs/common';
import type { ApiKey } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface CreateApiKeyInput {
  name: string;
  keyHash: string;
  prefix: string;
  scopes: string[];
  createdById: string;
  expiresAt?: Date;
}

/**
 * TZ §6.5 — only the SHA-256 `keyHash` + display `prefix` are ever persisted; the
 * plaintext key never reaches this layer (it exists only inside the service method that
 * generates it, for the single response that shows it once).
 */
@Injectable()
export class ApiKeysRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateApiKeyInput): Promise<ApiKey> {
    return this.prisma.apiKey.create({ data: input });
  }

  list(): Promise<ApiKey[]> {
    return this.prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } });
  }

  findById(id: string): Promise<ApiKey | null> {
    return this.prisma.apiKey.findUnique({ where: { id } });
  }

  /** Looks up by hash regardless of revoked/expired state, so the caller can tell
   * "wrong key" apart from "right key, but revoked/expired" (TZ §20 stable codes). */
  findByHash(keyHash: string): Promise<ApiKey | null> {
    return this.prisma.apiKey.findUnique({ where: { keyHash } });
  }

  revoke(id: string): Promise<ApiKey> {
    return this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  }

  updateScopes(id: string, scopes: string[]): Promise<ApiKey> {
    return this.prisma.apiKey.update({ where: { id }, data: { scopes } });
  }

  touchLastUsed(id: string): Promise<ApiKey> {
    return this.prisma.apiKey.update({ where: { id }, data: { lastUsedAt: new Date() } });
  }
}
