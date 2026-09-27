import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { LogsService } from '../../logs/logs.service';
import type { RodsReportParamsDto } from '../dto/reports.dto';
import { renderPdf } from '../lib/pdf-render';

/** B-14 — caps total driver-days rendered into one PDF; `RodsReportParamsDto` already bounds
 * the date range to `MAX_FMCSA_PACK_RANGE_DAYS`, this additionally bounds driver count x days
 * (§22 DoS control, same reasoning as `ActivityReportGenerator.pdf`'s `PDF_ROW_CAP`). */
const PDF_DAY_CAP = 2_000;

export interface RodsDayPage {
  driverName: string;
  cdlNumber: string;
  date: string;
  timezone: string;
  offDutyHours: string;
  sleeperHours: string;
  drivingHours: string;
  onDutyHours: string;
  totalDistanceMi: number;
  certified: boolean;
  eventLines: string;
}

/**
 * B-14 — `RODS`: printable §395 daily log sheets, one page per driver per day, reusing
 * `LogsService.getRange`/`getEvents` (Phase 5) so the printed sheet can never disagree with
 * the driver/DOT inspector's online RODS view (same reuse rule `ActivityReportGenerator`
 * already follows for the same reason).
 */
@Injectable()
export class RodsReportGenerator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logs: LogsService,
  ) {}

  async pdf(params: RodsReportParamsDto): Promise<{ pdf: Buffer; rowCount: number }> {
    const drivers = await this.prisma.driver.findMany({
      where: { status: 'ACTIVE', ...(params.driverId ? { id: params.driverId } : {}) },
      orderBy: { id: 'asc' },
      select: { id: true, firstName: true, lastName: true, cdlNumber: true },
    });

    const pages: RodsDayPage[] = [];
    outer: for (const driver of drivers) {
      const range = await this.logs.getRange(driver.id, params.from, params.to);
      for (const day of range.days) {
        if (pages.length >= PDF_DAY_CAP) break outer;
        const eventsResult = await this.logs.getEvents(driver.id, day.date);
        const eventLines = eventsResult.events
          .map((e) => `${new Date(e.eventDateTime).toISOString()} — ${e.status ?? ''} ${e.locationName ?? ''} (${e.totalVehicleMiles ?? ''} mi)`)
          .join(' | ');
        pages.push({
          driverName: `${driver.lastName}, ${driver.firstName}`,
          cdlNumber: driver.cdlNumber,
          date: day.date,
          timezone: day.timezone,
          offDutyHours: secToHours(day.offDutySec),
          sleeperHours: secToHours(day.sleeperSec),
          drivingHours: secToHours(day.drivingSec),
          onDutyHours: secToHours(day.onDutySec),
          totalDistanceMi: day.totalDistanceMi,
          certified: day.certified,
          eventLines: eventLines || '(no §395 records this day)',
        });
      }
    }

    const pdf = await renderPdf('rods-report', { from: params.from, to: params.to, pages });
    return { pdf, rowCount: pages.length };
  }
}

function secToHours(sec: number): string {
  return (sec / 3600).toFixed(2);
}
