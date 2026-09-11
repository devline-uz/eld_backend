import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../../core/observability/observability.module';
import { HosRecalcModule } from '../hos-recalc/hos-recalc.module';
import { HosDriftService } from './hos-drift.service';
import { HosStateController } from './hos-state.controller';
import { HosStateRepository } from './hos-state.repository';
import { HosStateService } from './hos-state.service';

/**
 * TZ §8.6 — the mobile/server HOS state exchange. The controller half runs in the API
 * container; `HosDriftService` is driven by `HosDriftProcessor` in the worker (§3.3).
 * `modules/hos/` stays pure — nothing here leaks back into it.
 */
@Module({
  imports: [HosRecalcModule, ObservabilityModule],
  controllers: [HosStateController],
  providers: [HosStateService, HosStateRepository, HosDriftService],
  exports: [HosStateService, HosDriftService, HosStateRepository],
})
export class HosStateModule {}
