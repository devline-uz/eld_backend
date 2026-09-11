import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RetentionPurgeService } from './retention-purge.service';
import { RetentionRepository } from './retention.repository';
import { RetentionService } from './retention.service';

/** TZ §5.5/§18/§23 — RODS (EldEvent) 6-month-floor / audit (AuditLog) 24-month-floor
 * retention. Worker-only (`retention.processor.ts` in `src/workers`); no controller, no
 * HTTP surface — this is a nightly maintenance job, not an API. */
@Module({
  imports: [AuditModule],
  providers: [RetentionRepository, RetentionPurgeService, RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
