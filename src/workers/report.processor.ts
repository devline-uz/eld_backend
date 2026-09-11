import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';
import { DateTime } from 'luxon';
import { PrismaService } from '../core/prisma/prisma.service';
import { QUEUES } from '../core/queue/queue.constants';
import { STORAGE_PORT, StoragePort } from '../core/storage/storage.port';
import { EventBusService } from '../core/events/event-bus.service';
import { ActivityReportGenerator } from '../modules/reports/generators/activity-report.generator';
import { DvirReportGenerator } from '../modules/reports/generators/dvir-report.generator';
import { FmcsaPackGenerator } from '../modules/reports/generators/fmcsa-pack.generator';
import { IftaReportGenerator } from '../modules/reports/generators/ifta-report.generator';
import type { ActivityReportParamsDto, DvirReportParamsDto, FmcsaPackParamsDto, IftaReportParamsDto } from '../modules/reports/dto/reports.dto';
import type { ReportJobData } from '../modules/reports/reports.service';
import { REPORT_RETENTION_MONTHS } from '../modules/reports/reports.service';

/**
 * TZ §15 — `report.generate` job: builds the file (streamed for CSV, rendered for PDF),
 * stores it via `StoragePort` and updates the `Report` row. Never runs in the API container
 * (§3.3). This is the ONLY place a report file is produced — `POST /reports/generate` only
 * enqueues.
 */
@Processor(QUEUES.REPORT, { concurrency: 2 })
export class ReportProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly events: EventBusService,
    private readonly iftaGen: IftaReportGenerator,
    private readonly activityGen: ActivityReportGenerator,
    private readonly dvirGen: DvirReportGenerator,
    private readonly fmcsaGen: FmcsaPackGenerator,
  ) {
    super();
  }

  async process(job: Job<ReportJobData>): Promise<void> {
    if (job.name !== 'report.generate') return;
    const { reportId } = job.data;
    const report = await this.prisma.report.findUnique({ where: { id: reportId } });
    if (!report) {
      this.logger.warn({ reportId }, 'report.generate for a Report row that no longer exists — dropped');
      return;
    }

    await this.prisma.report.update({ where: { id: reportId }, data: { status: 'RUNNING' } });

    try {
      const { fileKey, fileSizeBytes, rowCount } = await this.produce(report.id, report.type, report.params as Record<string, unknown>);
      // B-0xx: `Date.prototype.getMonth`/`setMonth` read/write the SERVER's local calendar,
      // not UTC (tasks.md compliance checklist "All timestamps stored in UTC..."). Under a
      // non-UTC `TZ`, that could shift `expiresAt` by up to a day around a month boundary.
      // `DateTime.utc()` does the month arithmetic on the UTC calendar explicitly.
      const expiresAt = DateTime.utc().plus({ months: REPORT_RETENTION_MONTHS }).toJSDate();

      const updated = await this.prisma.report.update({
        where: { id: reportId },
        data: { status: 'READY', fileKey, fileSizeBytes, rowCount, completedAt: new Date(), expiresAt },
      });

      await this.events.publish('realtime.push', {
        room: `user:${updated.requestedById}`,
        event: 'report.ready',
        payload: { reportId: updated.id, type: updated.type, status: updated.status },
      });
      this.logger.log({ reportId, type: report.type, fileSizeBytes, rowCount }, 'report.generate completed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.report.update({ where: { id: reportId }, data: { status: 'FAILED', error: message } });
      this.logger.error({ reportId, err }, 'report.generate failed');
      throw err;
    }
  }

  private async produce(
    reportId: string,
    type: string,
    params: Record<string, unknown>,
  ): Promise<{ fileKey: string; fileSizeBytes: number; rowCount: number | null }> {
    switch (type) {
      case 'IFTA': {
        const { stream, rowCount } = await this.iftaGen.stream(params as unknown as IftaReportParamsDto);
        const { key, sizeBytes } = await this.storage.putStream!(`reports/${reportId}.csv`, stream, { contentType: 'text/csv' });
        return { fileKey: key, fileSizeBytes: sizeBytes, rowCount };
      }
      case 'ACTIVITY': {
        const { stream, countRows } = await this.activityGen.stream(params as unknown as ActivityReportParamsDto);
        const { key, sizeBytes } = await this.storage.putStream!(`reports/${reportId}.csv`, stream, { contentType: 'text/csv' });
        return { fileKey: key, fileSizeBytes: sizeBytes, rowCount: countRows() };
      }
      case 'DVIR': {
        const { stream } = this.dvirGen.stream(params as unknown as DvirReportParamsDto);
        const { key, sizeBytes } = await this.storage.putStream!(`reports/${reportId}.csv`, stream, { contentType: 'text/csv' });
        return { fileKey: key, fileSizeBytes: sizeBytes, rowCount: null };
      }
      case 'FMCSA_PACK': {
        const { coverPdf, driverEntries } = await this.fmcsaGen.build(params as unknown as FmcsaPackParamsDto, reportId);
        const fileKey = await this.storage.put(`reports/${reportId}.pdf`, coverPdf, { contentType: 'application/pdf' });
        // Referenced Appendix A files are already stored by the generator (reports/{id}/{driverId}-*.csv);
        // record their keys on the Report row for the UI to list alongside the cover PDF.
        await this.prisma.report.update({
          where: { id: reportId },
          data: { params: JSON.parse(JSON.stringify({ ...params, driverFiles: driverEntries })) as Prisma.InputJsonValue },
        });
        return { fileKey, fileSizeBytes: coverPdf.length, rowCount: driverEntries.length };
      }
      default:
        throw new Error(`Unknown report type "${type}"`);
    }
  }
}
