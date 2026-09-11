import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/prisma/prisma.service';
import type { DvirReportParamsDto } from '../dto/reports.dto';
import { csvFromRows } from '../lib/csv-stream';

export interface DvirReportRow {
  dvirId: string;
  submittedAt: string;
  type: string;
  vehicleId: string;
  driverId: string;
  odometerMi: number;
  vehicleCondition: string;
  repairStatus: string;
  defectCount: number;
  openDefects: number;
  criticalOpenDefects: number;
  workOrderIds: string;
}

const PAGE_SIZE = 100;

/**
 * TZ §11.6 `/reports/dvir` — reads Phase 7's `Dvir`/`Defect`/`WorkOrder` tables directly
 * (no reimplementation). Cursor-paginated so an 8-day, fleet-wide DVIR export never loads
 * more than one page into memory (TZ §15).
 */
@Injectable()
export class DvirReportGenerator {
  constructor(private readonly prisma: PrismaService) {}

  async *rows(params: DvirReportParamsDto): AsyncGenerator<DvirReportRow> {
    const from = new Date(`${params.from}T00:00:00.000Z`);
    const to = new Date(`${params.to}T23:59:59.999Z`);
    const vehicleFilter = params.vehicleId ? { vehicleId: params.vehicleId } : {};
    let cursor: string | undefined;

    for (;;) {
      const dvirs = await this.prisma.dvir.findMany({
        where: { submittedAt: { gte: from, lte: to }, ...vehicleFilter },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { defects: { select: { status: true, severity: true, workOrderId: true } } },
      });
      if (dvirs.length === 0) return;
      for (const dvir of dvirs) {
        const openDefects = dvir.defects.filter((d) => d.status === 'OPEN');
        yield {
          dvirId: dvir.id,
          submittedAt: dvir.submittedAt.toISOString(),
          type: dvir.type,
          vehicleId: dvir.vehicleId,
          driverId: dvir.driverId,
          odometerMi: dvir.odometerMi,
          vehicleCondition: dvir.vehicleCondition,
          repairStatus: dvir.repairStatus,
          defectCount: dvir.defects.length,
          openDefects: openDefects.length,
          criticalOpenDefects: openDefects.filter((d) => d.severity === 'CRITICAL').length,
          workOrderIds: [...new Set(dvir.defects.map((d) => d.workOrderId).filter(Boolean))].join(';'),
        };
      }
      cursor = dvirs[dvirs.length - 1].id;
      if (dvirs.length < PAGE_SIZE) return;
    }
  }

  stream(params: DvirReportParamsDto): { stream: NodeJS.ReadableStream } {
    return { stream: csvFromRows(this.rows(params)) };
  }
}
