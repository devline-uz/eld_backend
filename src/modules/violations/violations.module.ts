import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ViolationsController } from './violations.controller';
import { ViolationsRepository } from './violations.repository';
import { ViolationsService } from './violations.service';

/** B-6 — fleet `HosViolation` list and manual resolve (tz.md §11.4). */
@Module({
  imports: [AuditModule],
  controllers: [ViolationsController],
  providers: [ViolationsService, ViolationsRepository],
  exports: [ViolationsService],
})
export class ViolationsModule {}
