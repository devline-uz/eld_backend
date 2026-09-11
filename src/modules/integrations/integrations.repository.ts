import { Injectable } from '@nestjs/common';
import type { Integration, IntegrationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

@Injectable()
export class IntegrationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(): Promise<Integration[]> {
    return this.prisma.integration.findMany({ orderBy: { provider: 'asc' } });
  }

  findByProvider(provider: string): Promise<Integration | null> {
    return this.prisma.integration.findUnique({ where: { provider } });
  }

  findById(id: string): Promise<Integration | null> {
    return this.prisma.integration.findUnique({ where: { id } });
  }

  upsert(
    provider: string,
    data: { enabled: boolean; config: Prisma.InputJsonValue; status: IntegrationStatus; lastError?: string | null },
  ): Promise<Integration> {
    return this.prisma.integration.upsert({
      where: { provider },
      create: { provider, ...data },
      update: data,
    });
  }

  setStatus(provider: string, status: IntegrationStatus, lastError: string | null, lastSyncAt?: Date): Promise<Integration> {
    return this.prisma.integration.update({
      where: { provider },
      data: { status, lastError, ...(lastSyncAt ? { lastSyncAt } : {}) },
    });
  }
}
