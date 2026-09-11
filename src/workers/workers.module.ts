import { Module } from '@nestjs/common';
import { HosRecalcModule } from '../modules/hos-recalc/hos-recalc.module';
import { HosStateModule } from '../modules/hos-state/hos-state.module';
import { IntegrationsModule } from '../modules/integrations/integrations.module';
import { ServiceModule } from '../modules/service/service.module';
import { TransfersModule } from '../modules/transfers/transfers.module';
import { WebhooksModule } from '../modules/webhooks/webhooks.module';
import { HosDriftProcessor } from './hos-drift.processor';
import { HosRecalcProcessor } from './hos-recalc.processor';
import { MaintenanceDueProcessor } from './maintenance-due.processor';
import { TransferProcessor } from './transfer.processor';
import { WebhookProcessor } from './webhook.processor';

/**
 * BullMQ processors live here and are loaded ONLY by worker.ts (TZ §3.3 — heavy work
 * never runs in the API container). Processors are added by their owning phase:
 *   hos-recalc.processor.ts   Phase 4  (eld-hos-engine) — registered
 *   hos-drift.processor.ts    Phase 4b (eld-hos-engine) — registered, nightly §8.6 sweep
 *   report.processor.ts       Phase 8  (eld-reports-jobs)
 *   transfer.processor.ts     Phase 9  (eld-compliance-rods) — registered, §10.1/§10.4 send step
 *   alert.processor.ts        Phase 10 (eld-reports-jobs)
 *   safety-detect.processor.ts Phase 10 (eld-fleet-ops)
 *   webhook.processor.ts      Phase 11 (eld-reports-jobs)
 *   maintenance-due.processor.ts Phase 7 (eld-fleet-ops) — registered, nightly §5.10 sweep
 *   retention.processor.ts    Phase 12 (eld-devops)
 */
@Module({
  imports: [HosRecalcModule, HosStateModule, IntegrationsModule, TransfersModule, WebhooksModule, ServiceModule],
  providers: [HosRecalcProcessor, HosDriftProcessor, TransferProcessor, WebhookProcessor, MaintenanceDueProcessor],
  exports: [],
})
export class WorkersModule {}
