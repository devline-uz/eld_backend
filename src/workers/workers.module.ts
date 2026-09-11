import { Module } from '@nestjs/common';
import { AuditModule } from '../modules/audit/audit.module';
import { GeofencesModule } from '../modules/geofences/geofences.module';
import { HosRecalcModule } from '../modules/hos-recalc/hos-recalc.module';
import { HosStateModule } from '../modules/hos-state/hos-state.module';
import { IntegrationsModule } from '../modules/integrations/integrations.module';
import { MobileModule } from '../modules/mobile/mobile.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { ReportsModule } from '../modules/reports/reports.module';
import { RetentionModule } from '../modules/retention/retention.module';
import { SafetyModule } from '../modules/safety/safety.module';
import { ServiceModule } from '../modules/service/service.module';
import { TransfersModule } from '../modules/transfers/transfers.module';
import { WebhooksModule } from '../modules/webhooks/webhooks.module';
import { AlertProcessor } from './alert.processor';
import { HosDriftProcessor } from './hos-drift.processor';
import { HosRecalcProcessor } from './hos-recalc.processor';
import { IftaNightlyProcessor } from './ifta-nightly.processor';
import { MaintenanceDueProcessor } from './maintenance-due.processor';
import { ReportProcessor } from './report.processor';
import { ReportSchedulerProcessor } from './report-scheduler.processor';
import { RetentionProcessor } from './retention.processor';
import { SafetyDetectProcessor } from './safety-detect.processor';
import { TransferProcessor } from './transfer.processor';
import { WebhookProcessor } from './webhook.processor';

/**
 * BullMQ processors live here and are loaded ONLY by worker.ts (TZ §3.3 — heavy work
 * never runs in the API container). Processors are added by their owning phase:
 *   hos-recalc.processor.ts   Phase 4  (eld-hos-engine) — registered
 *   hos-drift.processor.ts    Phase 4b (eld-hos-engine) — registered, nightly §8.6 sweep
 *   report.processor.ts       Phase 8  (eld-reports-jobs) — registered, §15 report.generate
 *   report-scheduler.processor.ts Phase 8 (eld-reports-jobs) — registered, §15 cron scheduler
 *   ifta-nightly.processor.ts Phase 8  (eld-reports-jobs) — registered, nightly §15 IftaSegment
 *   transfer.processor.ts     Phase 9  (eld-compliance-rods) — registered, §10.1/§10.4 send step
 *   alert.processor.ts        Phase 10 (eld-reports-jobs)
 *   safety-detect.processor.ts Phase 10 (eld-fleet-ops)
 *   webhook.processor.ts      Phase 11 (eld-reports-jobs)
 *   maintenance-due.processor.ts Phase 7 (eld-fleet-ops) — registered, nightly §5.10 sweep
 *   retention.processor.ts    registered — nightly §5.5/§18/§23 RODS 6mo/audit 24mo sweep
 */
@Module({
  imports: [
    AuditModule,
    HosRecalcModule,
    HosStateModule,
    IntegrationsModule,
    TransfersModule,
    WebhooksModule,
    ServiceModule,
    NotificationsModule,
    MobileModule,
    SafetyModule,
    GeofencesModule,
    ReportsModule,
    RetentionModule,
  ],
  providers: [
    HosRecalcProcessor,
    HosDriftProcessor,
    TransferProcessor,
    WebhookProcessor,
    MaintenanceDueProcessor,
    AlertProcessor,
    SafetyDetectProcessor,
    ReportProcessor,
    ReportSchedulerProcessor,
    IftaNightlyProcessor,
    RetentionProcessor,
  ],
  exports: [],
})
export class WorkersModule {}
