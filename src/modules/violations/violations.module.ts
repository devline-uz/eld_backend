import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { HosRecalcModule } from '../hos-recalc/hos-recalc.module';
import { ActiveViolationsService } from './active-violations.service';
import { ViolationsController } from './violations.controller';
import { ViolationsRepository } from './violations.repository';
import { ViolationsService } from './violations.service';

/** B-6 — fleet `HosViolation` list and manual resolve (tz.md §11.4). BUG-003 — `ActiveViolationsService`
 * is the one web-panel definition of an active violation (dashboard, roster, HOS log). */
@Module({
  imports: [AuditModule, HosRecalcModule],
  controllers: [ViolationsController],
  providers: [ViolationsService, ViolationsRepository, ActiveViolationsService],
  exports: [ViolationsService, ActiveViolationsService],
})
export class ViolationsModule {}
