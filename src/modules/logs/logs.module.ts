import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { IngestModule } from '../ingest/ingest.module';
import { LogsController } from './logs.controller';
import { LogsRepository } from './logs.repository';
import { LogsService } from './logs.service';
import { MobileLogsController } from './mobile-logs.controller';
import { RodsEventWriter } from './rods-event-writer';

/**
 * TZ §9 — RODS. Imports `IngestModule` for `IngestRepository`: the `eventSequenceId`
 * allocator and the partition guard are §7.3 rule 8 machinery and exist exactly once.
 */
@Module({
  imports: [IngestModule, AuditModule],
  controllers: [LogsController, MobileLogsController],
  providers: [LogsService, LogsRepository, RodsEventWriter],
  exports: [LogsService, LogsRepository, RodsEventWriter],
})
export class LogsModule {}
