import { Module } from '@nestjs/common';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { DeviceEventsService } from './device-events.service';
import { IngestController } from './ingest.controller';
import { IngestRepository } from './ingest.repository';
import { IngestService } from './ingest.service';

/** TZ §7 — app → server gateway ingest (events, telemetry, raw device events, BLE state, device status). */
@Module({
  imports: [TelemetryModule],
  controllers: [IngestController],
  providers: [IngestService, IngestRepository, DeviceEventsService],
  exports: [IngestService, IngestRepository],
})
export class IngestModule {}
