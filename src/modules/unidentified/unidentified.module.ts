import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LogsModule } from '../logs/logs.module';
import { UnidentifiedController } from './unidentified.controller';
import { UnidentifiedRepository } from './unidentified.repository';
import { UnidentifiedService } from './unidentified.service';

/** TZ §5.9 / §7.4 — unidentified driving assignment, annotation and rejection. */
@Module({
  imports: [LogsModule, AuditModule],
  controllers: [UnidentifiedController],
  providers: [UnidentifiedService, UnidentifiedRepository],
  exports: [UnidentifiedService],
})
export class UnidentifiedModule {}
