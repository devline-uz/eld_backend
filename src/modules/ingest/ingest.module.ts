import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { IngestController } from './ingest.controller';
import { IngestRepository } from './ingest.repository';
import { IngestService } from './ingest.service';

/** TZ §7 — app → server gateway ingest (events, telemetry, BLE state, device status). */
@Module({
  imports: [TelemetryModule],
  controllers: [IngestController],
  providers: [IngestService, IngestRepository],
  exports: [IngestService, IngestRepository],
})
export class IngestModule {}
