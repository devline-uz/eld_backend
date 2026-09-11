import { Injectable } from '@nestjs/common';
import type { DiagnosticTroubleCode, Prisma } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

/**
 * TZ §5.7 — DTC (J1939 SPN/FMI) persistence. `DiagnosticTroubleCode` has no relation column
 * to `Vehicle` in the schema (scalar `vehicleId` only), so every read here filters on it
 * directly rather than via a Prisma relation.
 */
@Injectable()
export class DtcRepository extends BaseRepository<
  DiagnosticTroubleCode,
  Prisma.DiagnosticTroubleCodeWhereInput,
  Prisma.DiagnosticTroubleCodeWhereUniqueInput,
  Prisma.DiagnosticTroubleCodeCreateInput,
  Prisma.DiagnosticTroubleCodeUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    DiagnosticTroubleCode,
    Prisma.DiagnosticTroubleCodeWhereInput,
    Prisma.DiagnosticTroubleCodeWhereUniqueInput,
    Prisma.DiagnosticTroubleCodeCreateInput,
    Prisma.DiagnosticTroubleCodeUpdateInput
  > {
    return this.prisma.diagnosticTroubleCode;
  }

  findOpenByCode(vehicleId: string, spn: number | null, fmi: number | null): Promise<DiagnosticTroubleCode | null> {
    return this.prisma.diagnosticTroubleCode.findFirst({
      where: { vehicleId, spn, fmi, clearedAt: null },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  bumpOccurrence(id: string, lastSeenAt: Date): Promise<DiagnosticTroubleCode> {
    return this.prisma.diagnosticTroubleCode.update({
      where: { id },
      data: { occurrence: { increment: 1 }, lastSeenAt },
    });
  }

  listForVehicle(vehicleId: string, includeCleared: boolean): Promise<DiagnosticTroubleCode[]> {
    return this.prisma.diagnosticTroubleCode.findMany({
      where: { vehicleId, ...(includeCleared ? {} : { clearedAt: null }) },
      orderBy: [{ clearedAt: 'asc' }, { lastSeenAt: 'desc' }],
    });
  }

  async clearAllOpen(vehicleId: string, clearedAt: Date): Promise<number> {
    const result = await this.prisma.diagnosticTroubleCode.updateMany({
      where: { vehicleId, clearedAt: null },
      data: { clearedAt },
    });
    return result.count;
  }
}
