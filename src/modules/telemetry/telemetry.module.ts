import { Module } from '@nestjs/common';
import { DtcModule } from '../dtc/dtc.module';
import { TelemetryRepository } from './telemetry.repository';
import { TelemetryService } from './telemetry.service';

/** TZ §5.6 — Virtual Dashboard. The write path is driven by `IngestModule`; read endpoints
 * belong to the Virtual Dashboard phase and are added there. `DtcModule` (Phase 7, TZ §5.7)
 * is imported one-directionally so `TelemetryService.store` can capture per-code DTC rows
 * behind `dtcCount`/`dtcCodes` without `DtcModule` knowing anything about telemetry. */
@Module({
  imports: [DtcModule],
  providers: [TelemetryService, TelemetryRepository],
  exports: [TelemetryService, TelemetryRepository],
})
export class TelemetryModule {}
