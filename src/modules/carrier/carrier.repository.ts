import { Injectable } from '@nestjs/common';
import type { Carrier, Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export const CARRIER_ID = 'carrier';

/**
 * TZ §5.1 — single-row profile table (`id = 'carrier'`), never env config. Not extended from
 * `BaseRepository` because the model has exactly one row and none of the list/paginate methods
 * apply; `get()`/`upsert()` are the only two operations that make sense here.
 */
@Injectable()
export class CarrierRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<Carrier | null> {
    return this.prisma.carrier.findUnique({ where: { id } });
  }

  get(): Promise<Carrier | null> {
    return this.prisma.carrier.findUnique({ where: { id: CARRIER_ID } });
  }

  /** Creates the singleton row on first read if a migration/seed hasn't already, per TZ §5.1 defaults. */
  ensure(): Promise<Carrier> {
    return this.prisma.carrier.upsert({
      where: { id: CARRIER_ID },
      create: { id: CARRIER_ID, name: 'Carrier', dotNumber: '' },
      update: {},
    });
  }

  update(data: Prisma.CarrierUpdateInput): Promise<Carrier> {
    return this.prisma.carrier.update({ where: { id: CARRIER_ID }, data });
  }
}
