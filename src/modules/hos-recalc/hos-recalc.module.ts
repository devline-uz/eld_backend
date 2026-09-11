import { Module } from '@nestjs/common';
import { HosRecalcRepository } from './hos-recalc.repository';
import { HosRecalcService } from './hos-recalc.service';

/**
 * TZ §8.4 — the persistence side of the HOS engine. Deliberately a SEPARATE module from
 * `modules/hos/`, which must stay pure (§3.5 exception): the Dart port mirrors `hos/` only.
 */
@Module({
  providers: [HosRecalcService, HosRecalcRepository],
  exports: [HosRecalcService, HosRecalcRepository],
})
export class HosRecalcModule {}
