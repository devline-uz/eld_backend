import { Injectable } from '@nestjs/common';
import type { Dvir, Prisma } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface DvirListFilter {
  vehicleId?: string;
  driverId?: string;
  repairStatus?: Dvir['repairStatus'];
  /** §20 B-47. */
  from?: Date;
  to?: Date;
}

export interface DvirListPage {
  items: Dvir[];
  total: number;
}

/** TZ §5.10 — web-side read of DVIRs the mobile app submitted, plus the mechanic sign-off
 * step. Driver-side submission is `MobileDvirService` (Phase 6); this is the "DVIR &
 * Maintenance" screen's read/review path. */
@Injectable()
export class DvirAdminRepository extends BaseRepository<
  Dvir,
  Prisma.DvirWhereInput,
  Prisma.DvirWhereUniqueInput,
  Prisma.DvirCreateInput,
  Prisma.DvirUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<Dvir, Prisma.DvirWhereInput, Prisma.DvirWhereUniqueInput, Prisma.DvirCreateInput, Prisma.DvirUpdateInput> {
    return this.prisma.dvir;
  }

  async list(filter: DvirListFilter, page: number, limit: number, orderBy: Record<string, 'asc' | 'desc'>): Promise<DvirListPage> {
    const where: Prisma.DvirWhereInput = {
      ...(filter.vehicleId && { vehicleId: filter.vehicleId }),
      ...(filter.driverId && { driverId: filter.driverId }),
      ...(filter.repairStatus && { repairStatus: filter.repairStatus }),
      ...((filter.from || filter.to) && {
        submittedAt: { ...(filter.from && { gte: filter.from }), ...(filter.to && { lte: filter.to }) },
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.dvir.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.dvir.count({ where }),
    ]);
    return { items, total };
  }

  /** §20 B-47 `GET /dvir/compliance` — active vehicles expected to submit a PRE_TRIP DVIR each
   * day in `[from, to]`; `submittedByVehicleAndDate` groups actual PRE_TRIP submissions the same
   * way so the service can diff the two sets without an N+1 per vehicle/day. */
  activeVehicles(): Promise<Array<{ id: string; unitNumber: string }>> {
    return this.prisma.vehicle.findMany({ where: { status: 'ACTIVE' }, select: { id: true, unitNumber: true } });
  }

  submittedPreTrips(from: Date, to: Date): Promise<Array<{ vehicleId: string; submittedAt: Date }>> {
    return this.prisma.dvir.findMany({
      where: { type: 'PRE_TRIP', submittedAt: { gte: from, lte: to } },
      select: { vehicleId: true, submittedAt: true },
    });
  }

  findWithDefects(id: string) {
    return this.prisma.dvir.findUnique({
      where: { id },
      include: { defects: { include: { photos: true } }, photos: true },
    });
  }

  /** B-75 — same shape as `findWithDefects` plus driver/vehicle names, for the single-DVIR
   * PDF (`dvir-pdf.builder.ts`), which is a print artifact and needs readable identifiers
   * rather than bare foreign-key ids. */
  findForPdf(id: string) {
    return this.prisma.dvir.findUnique({
      where: { id },
      include: {
        defects: { include: { photos: true } },
        photos: true,
        driver: { select: { firstName: true, lastName: true, cdlNumber: true } },
        vehicle: { select: { unitNumber: true, vin: true, licensePlate: true, plateState: true } },
        trailer: { select: { number: true } },
      },
    });
  }
}
