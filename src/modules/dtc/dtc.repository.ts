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

  /** Open row for one dedupe key (rides the `(vehicleId, spn, fmi, code)` index). A `null`
   * part matches `IS NULL`, so J1939 (`code` null), J1708 (`spn` null) and OBD-II (`spn`/`fmi`
   * null) keys never collide with each other. */
  findOpenByCode(
    vehicleId: string,
    key: { spn: number | null; fmi: number | null; code: string | null },
  ): Promise<DiagnosticTroubleCode | null> {
    return this.prisma.diagnosticTroubleCode.findFirst({
      where: { vehicleId, spn: key.spn, fmi: key.fmi, code: key.code, clearedAt: null },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  /** Repeat sighting: `occurrence` is the device's own count when it reports one (never lowered),
   * else +1; the latest bus / MIL / active state wins. */
  bumpOccurrence(
    id: string,
    lastSeenAt: Date,
    patch: Pick<Prisma.DiagnosticTroubleCodeUpdateInput, 'occurrence' | 'bus' | 'milOn' | 'active' | 'conversionMethod'> = {},
  ): Promise<DiagnosticTroubleCode> {
    return this.prisma.diagnosticTroubleCode.update({
      where: { id },
      data: { occurrence: { increment: 1 }, ...patch, lastSeenAt },
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
