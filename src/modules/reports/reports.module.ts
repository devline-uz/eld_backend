import { Module } from '@nestjs/common';
import { LogsModule } from '../logs/logs.module';
import { TransfersModule } from '../transfers/transfers.module';
import { ActivityReportGenerator } from './generators/activity-report.generator';
import { ActivitySummaryGenerator } from './generators/activity-summary.generator';
import { DvirReportGenerator } from './generators/dvir-report.generator';
import { FmcsaPackGenerator } from './generators/fmcsa-pack.generator';
import { IdleFuelReportGenerator } from './generators/idle-fuel-report.generator';
import { IftaReportGenerator } from './generators/ifta-report.generator';
import { RodsReportGenerator } from './generators/rods-report.generator';
import { IftaSegmentsRepository } from './ifta/ifta-segments.repository';
import { IftaSegmentsService } from './ifta/ifta-segments.service';
import { ReportsController } from './reports.controller';
import { ReportSchedulesRepository, ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';
import { ScheduledReportMailer } from './scheduled-report-mailer';

/**
 * TZ §15 — Phase 8 reports. Imported by both `app.module.ts` (controller + `generate()`
 * enqueue) and `workers.module.ts` (generators + `IftaSegmentsService`, consumed by
 * `report.processor.ts` / `ifta-nightly.processor.ts` / `report-scheduler.processor.ts`).
 * `LogsModule` for the activity report (reuses `LogsService.getRange`, Phase 5);
 * `TransfersModule` for the FMCSA pack (reuses the Appendix A output-file generator, Phase 9).
 */
@Module({
  imports: [LogsModule, TransfersModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    ReportsRepository,
    ReportSchedulesRepository,
    IftaReportGenerator,
    ActivityReportGenerator,
    ActivitySummaryGenerator,
    DvirReportGenerator,
    FmcsaPackGenerator,
    RodsReportGenerator,
    IdleFuelReportGenerator,
    IftaSegmentsService,
    IftaSegmentsRepository,
    ScheduledReportMailer,
  ],
  exports: [
    ReportsService,
    ReportsRepository,
    ReportSchedulesRepository,
    IftaReportGenerator,
    ActivityReportGenerator,
    ActivitySummaryGenerator,
    DvirReportGenerator,
    FmcsaPackGenerator,
    RodsReportGenerator,
    IdleFuelReportGenerator,
    IftaSegmentsService,
    IftaSegmentsRepository,
    ScheduledReportMailer,
  ],
})
export class ReportsModule {}
