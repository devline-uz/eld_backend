import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { dayEnd, dayStart } from '../hos/engine/timezone';
import { LogsRepository } from './logs.repository';
import { buildRodsDayCsv, rodsDayFileName } from './rods-day-csv';

export interface RodsDayExport {
  fileName: string;
  contentType: string;
  body: string;
}

/**
 * mobile/tz.md §21 MB-18 / P-05 `Download` — `GET /mobile/logs/:date/export?format=csv|pdf`.
 *
 * CSV: the driver's own RODS day, every §395 record (same list as the inspection packet).
 * PDF: 501 NOT_IMPLEMENTED — the puppeteer renderer in `reports/lib/pdf-render.ts` only has the
 * FMCSA-pack cover template, there is no per-day RODS template, and the dev host has no Chrome
 * binary to verify one with (decisions.md). The app prints the on-screen log / inspection
 * packet instead (P-13 `Printer`), which §395.24(d) accepts at roadside.
 */
@Injectable()
export class MobileLogsExportService {
  constructor(private readonly repo: LogsRepository) {}

  async exportDay(driverId: string, date: string, format: 'csv' | 'pdf'): Promise<RodsDayExport> {
    if (format === 'pdf') {
      throw new AppException(
        ERROR_CODES.NOT_IMPLEMENTED,
        'PDF export of a RODS day is not available yet — use format=csv or print the on-screen log.',
        501,
        { format },
      );
    }
    const driver = await this.repo.findDriver(driverId);
    if (!driver) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404, { driverId });
    const timezone = driver.homeTerminalTimezone;
    const endAt = dayEnd(timezone, date);
    // Half-open [start, end) exactly like the inspection packet (`LogsService.buildDays`).
    const events = (await this.repo.findEvents(driverId, dayStart(timezone, date), endAt)).filter(
      (event) => event.eventDateTime.getTime() < endAt.getTime(),
    );
    return {
      fileName: rodsDayFileName(date, 'csv'),
      contentType: 'text/csv; charset=utf-8',
      body: buildRodsDayCsv(events, timezone),
    };
  }
}
