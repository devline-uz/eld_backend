import { Injectable } from '@nestjs/common';
import type { ApiKey, Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface CreateApiKeyInput {
  name: string;
  keyHash: string;
  prefix: string;
  scopes: string[];
  createdById: string;
  expiresAt?: Date;
}

/** CODE-003 — what `verify()` needs about the key's creator, fetched in the same query. */
const CREATOR_SELECT = {
  createdBy: { select: { status: true, role: { select: { key: true, permissions: true } } } },
} satisfies Prisma.ApiKeyInclude;

export type ApiKeyWithCreator = Prisma.ApiKeyGetPayload<{ include: typeof CREATOR_SELECT }>;

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
  findByHash(keyHash: string): Promise<ApiKeyWithCreator | null> {
    return this.prisma.apiKey.findUnique({ where: { keyHash }, include: CREATOR_SELECT });
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
