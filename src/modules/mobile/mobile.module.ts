import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { HosRecalcModule } from '../hos-recalc/hos-recalc.module';
import { LogsModule } from '../logs/logs.module';
import { MobileBootstrapController } from './mobile-bootstrap.controller';
import { MobileBootstrapService } from './mobile-bootstrap.service';
import { MobileDutyStatusController } from './mobile-duty-status.controller';
import { MobileDvirController } from './mobile-dvir.controller';
import { MobileDvirService } from './mobile-dvir.service';
import { MobileSyncController } from './mobile-sync.controller';
import { MobileSyncService } from './mobile-sync.service';
import { MobileRepository } from './mobile.repository';
import { SignatureService } from './signature.service';

/**
 * TZ §6 (tasks.md Phase 6) — Mobile API: bootstrap, offline sync, duty-status, DVIR +
 * signature. `HosStateModule` (§8.6 point 5, `POST /mobile/hos-state`) is registered
 * separately in `app.module.ts` — it predates this module and is left untouched.
 */
@Module({
  imports: [HosRecalcModule, LogsModule, AuditModule],
  controllers: [MobileBootstrapController, MobileSyncController, MobileDutyStatusController, MobileDvirController],
  providers: [MobileRepository, MobileBootstrapService, MobileSyncService, MobileDvirService, SignatureService],
  exports: [MobileRepository, SignatureService],
})
export class MobileModule {}
