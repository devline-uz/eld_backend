import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';

/** MB-4 — the two lookups the RODS-day PDF header needs beyond `LogsRepository` (carrier + units). */
@Injectable()
export class RodsDayPdfRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCarrier() {
    return this.prisma.carrier.findFirst();
  }

  findVehicles(ids: string[]) {
    return this.prisma.vehicle.findMany({ where: { id: { in: ids } }, select: { unitNumber: true, vin: true } });
  }
}
