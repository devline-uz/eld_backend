import { Injectable } from '@nestjs/common';
import type { CoDriverPairing, Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface CoDriverPairingFilter {
  vehicleId?: string;
  driverId?: string;
  active?: boolean;
}

/** §20 B-7 — time-bounded co-driver pairing rows (hard rule: never a plain `Driver` column). */
@Injectable()
export class CoDriverPairingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<CoDriverPairing | null> {
    return this.prisma.coDriverPairing.findUnique({ where: { id } });
  }

  async list(filter: CoDriverPairingFilter, page: number, limit: number): Promise<{ items: CoDriverPairing[]; total: number }> {
    const where: Prisma.CoDriverPairingWhereInput = {
      ...(filter.vehicleId && { vehicleId: filter.vehicleId }),
      ...(filter.driverId && { OR: [{ primaryDriverId: filter.driverId }, { coDriverId: filter.driverId }] }),
      ...(filter.active === true && { endedAt: null }),
      ...(filter.active === false && { endedAt: { not: null } }),
    };
    const [items, total] = await Promise.all([
      this.prisma.coDriverPairing.findMany({ where, orderBy: { startedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.coDriverPairing.count({ where }),
    ]);
    return { items, total };
  }

  /** An active (not yet ended) pairing for this co-driver on this unit, if any — blocks a
   * second overlapping pairing for the same co-driver/unit pair. */
  findActiveForCoDriver(coDriverId: string, vehicleId: string): Promise<CoDriverPairing | null> {
    return this.prisma.coDriverPairing.findFirst({ where: { coDriverId, vehicleId, endedAt: null } });
  }

  create(data: Prisma.CoDriverPairingCreateInput): Promise<CoDriverPairing> {
    return this.prisma.coDriverPairing.create({ data });
  }

  end(id: string, endedById: string | undefined, endedAt: Date): Promise<CoDriverPairing> {
    return this.prisma.coDriverPairing.update({ where: { id }, data: { endedAt, endedById } });
  }
}
