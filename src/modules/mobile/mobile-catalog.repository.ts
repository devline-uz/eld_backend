import { Injectable } from '@nestjs/common';
import type { DefectCatalogItem, DefectPart, DriverSavedSignature } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

/**
 * MR-9 (DVIR defect catalog) and MR-27 (driver's saved signature) DB access. Its own repository
 * so the shared `MobileRepository` is not grown (mobile/decisions.md MD-001).
 */
@Injectable()
export class MobileCatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  listCatalog(part?: DefectPart): Promise<DefectCatalogItem[]> {
    return this.prisma.defectCatalogItem.findMany({
      where: { active: true, ...(part ? { part } : {}) },
      orderBy: [{ part: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  /** One query for every (part, code|name) a DVIR references — no per-defect lookups. */
  listCatalogLabels(parts: DefectPart[]): Promise<Pick<DefectCatalogItem, 'part' | 'code' | 'name'>[]> {
    if (!parts.length) return Promise.resolve([]);
    return this.prisma.defectCatalogItem.findMany({
      where: { part: { in: parts }, active: true },
      select: { part: true, code: true, name: true },
    });
  }

  getSavedSignature(driverId: string): Promise<DriverSavedSignature | null> {
    return this.prisma.driverSavedSignature.findUnique({ where: { driverId } });
  }

  upsertSavedSignature(
    driverId: string,
    data: { key: string; sha256: string; mimeType: string; sizeBytes: number },
  ): Promise<DriverSavedSignature> {
    return this.prisma.driverSavedSignature.upsert({ where: { driverId }, create: { driverId, ...data }, update: data });
  }

  async deleteSavedSignature(driverId: string): Promise<DriverSavedSignature | null> {
    const prior = await this.getSavedSignature(driverId);
    if (prior) await this.prisma.driverSavedSignature.delete({ where: { driverId } });
    return prior;
  }
}
