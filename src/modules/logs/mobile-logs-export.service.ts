import { Injectable } from '@nestjs/common';
import type { Driver } from '@prisma/client';
import { renderPdf } from '../reports/lib/pdf-render';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { addDays, dayEnd, dayStart } from '../hos/engine/timezone';
import { annotateSegments, tripBlockForDay } from './day-extras';
import { RODS_HEADER_LOOKBACK_DAYS } from './daily-log-header';
import { LogsRepository } from './logs.repository';
import { buildRodsDay } from './rods';
import { buildRodsDayPdfData } from './rods-day-pdf';
import { RodsDayPdfRepository } from './rods-day-pdf.repository';
import { buildRodsDayCsv, rodsDayFileName } from './rods-day-csv';

export interface RodsDayExport {
  fileName: string;
  contentType: string;
  body: string | Buffer;
}

/**
 * mobile/tz.md §21 MB-18 / P-05 `Download` — `GET /mobile/logs/:date/export?format=csv|pdf`.
 *
 * CSV: the driver's own RODS day, every §395 record (same list as the inspection packet).
 * PDF (MB-4): the §395.8 daily-log sheet — header fields, 24 h graph grid and remarks — built
 * from the same `buildRodsDay` + `annotateSegments` the online RODS view and the inspection
 * packet use, rendered through the shared Puppeteer helper (`reports/templates/rods-day.html`).
 * On-request on purpose: one driver-day, a single page (the §15 "queued report" rule is for bulk jobs).
 */
@Injectable()
export class MobileLogsExportService {
  constructor(
    private readonly repo: LogsRepository,
    private readonly pdfRepo: RodsDayPdfRepository,
  ) {}

  async exportDay(driverId: string, date: string, format: 'csv' | 'pdf', now: Date = new Date()): Promise<RodsDayExport> {
    const driver = await this.repo.findDriver(driverId);
    if (!driver) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404, { driverId });
    const timezone = driver.homeTerminalTimezone;
    if (format === 'pdf') return this.pdfDay(driver, date, now);
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

  private async pdfDay(driver: Driver, date: string, now: Date): Promise<RodsDayExport> {
    const timezone = driver.homeTerminalTimezone;
    const windowStart = dayStart(timezone, addDays(date, -RODS_HEADER_LOOKBACK_DAYS));
    const windowEnd = dayEnd(timezone, date);
    // Lookback so a status carried over midnight is drawn from 00:00 (same as the log view).
    const events = await this.repo.findEvents(driver.id, windowStart, windowEnd);
    const day = buildRodsDay(events, timezone, date, now);
    const segments = annotateSegments(day.segments, events);

    const dayEvents = events.filter((e) => e.eventDateTime >= day.startAt && e.eventDateTime < day.endAt);
    const vehicleIds = [...new Set(dayEvents.map((e) => e.vehicleId).filter((v): v is string => Boolean(v)))];
    const [carrier, vehicles, trips, headers] = await Promise.all([
      this.pdfRepo.findCarrier(),
      vehicleIds.length ? this.pdfRepo.findVehicles(vehicleIds) : [],
      this.repo.findTripsForDriver(driver.id, day.startAt, day.endAt),
      this.repo.findDailyLogs(driver.id, utcMidnight(date), utcMidnight(date)),
    ]);
    const trip = tripBlockForDay(trips, day.startAt, day.endAt, now);
    const header = headers[0];
    const address = carrier ? [carrier.addressLine1, carrier.city, [carrier.state, carrier.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';
    const data = buildRodsDayPdfData({
      day,
      segments,
      driver,
      carrier: carrier ? { name: carrier.name, dotNumber: carrier.dotNumber, address } : null,
      vehicles,
      trailerNumbers: trip.trailerNumbers,
      shippingDocuments: trip.shippingDocuments,
      certified: header?.certified ?? false,
      certifiedAt: header?.certifiedAt ?? null,
      generatedAt: now,
    });
    return { fileName: rodsDayFileName(date, 'pdf'), contentType: 'application/pdf', body: await renderPdf('rods-day', data) };
  }
}

function utcMidnight(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}
