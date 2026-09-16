import { Module } from '@nestjs/common';
import { HosRecalcModule } from '../hos-recalc/hos-recalc.module';
import { LiveFleetController } from './live-fleet.controller';
import { LiveFleetRepository } from './live-fleet.repository';
import { LiveFleetService } from './live-fleet.service';

/** web/tz.md §20 B-3 — `GET /live/fleet`. Read-only; HOS clocks come from `HosRecalcService`. */
@Module({
  imports: [HosRecalcModule],
  controllers: [LiveFleetController],
  providers: [LiveFleetService, LiveFleetRepository],
  exports: [LiveFleetService],
})
export class LiveFleetModule {}
