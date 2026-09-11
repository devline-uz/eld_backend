import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { LogsService } from '../../logs/logs.service';
import type { ActivityReportParamsDto } from '../dto/reports.dto';
import { csvFromRows } from '../lib/csv-stream';

export interface ActivityReportRow {
  driverId: string;
  driverName: string;
  date: string;
  drivingHours: string;
  onDutyHours: string;
  offDutyHours: string;
  sleeperHours: string;
  totalDistanceMi: number;
  certified: boolean;
  hasViolation: boolean;
  violationCount: number;
  hasUnassigned: boolean;
}

const PAGE_SIZE = 50;

/**
 * TZ §11.6 `/reports/activity` — per-driver, per-day HOS activity summary, reusing
 * `LogsService.getRange` (Phase 5) so the report can never disagree with the RODS view a
 * driver/DOT inspector sees. Drivers are paged (cursor) instead of loaded all at once
 * (TZ §15/§19 — a 250-driver × 8-day report target is 45s; N+1 whole-table loads are banned).
 */
@Injectable()
export class ActivityReportGenerator {
  constructor(private readonly prisma: PrismaService, private readonly logs: LogsService) {}

  async *rows(params: ActivityReportParamsDto): AsyncGenerator<ActivityReportRow> {
    let cursor: string | undefined;
    const driverFilter = params.driverId ? { id: params.driverId } : {};
    for (;;) {
      const drivers = await this.prisma.driver.findMany({
        where: { status: 'ACTIVE', ...driverFilter },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, firstName: true, lastName: true },
      });
      if (drivers.length === 0) return;
      for (const driver of drivers) {
        const range = await this.logs.getRange(driver.id, params.from, params.to);
        for (const day of range.days) {
          yield {
            driverId: driver.id,
            driverName: `${driver.lastName}, ${driver.firstName}`,
            date: day.date,
            drivingHours: (day.drivingSec / 3600).toFixed(2),
            onDutyHours: (day.onDutySec / 3600).toFixed(2),
            offDutyHours: (day.offDutySec / 3600).toFixed(2),
            sleeperHours: (day.sleeperSec / 3600).toFixed(2),
            totalDistanceMi: day.totalDistanceMi,
            certified: day.certified,
            hasViolation: day.hasViolation,
            violationCount: day.violationCount,
            hasUnassigned: day.hasUnassigned,
          };
        }
      }
      cursor = drivers[drivers.length - 1].id;
      if (drivers.length < PAGE_SIZE) return;
    }
  }

  async stream(params: ActivityReportParamsDto): Promise<{ stream: NodeJS.ReadableStream; countRows: () => number }> {
    let rowCount = 0;
    const source = this.rows(params);
    async function* counted(): AsyncGenerator<ActivityReportRow> {
      for await (const row of source) {
        rowCount += 1;
        yield row;
      }
    }
    return { stream: csvFromRows(counted()), countRows: () => rowCount };
  }
}
