import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { CarrierModule } from '../carrier/carrier.module';
import { ReplacedDeviceReviewModule } from '../logs/replaced-device-review';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { DeviceEventsService } from './device-events.service';
import { IngestController } from './ingest.controller';
import { IngestRepository } from './ingest.repository';
import { IngestService } from './ingest.service';
import { DriverActivityInterceptor, SessionActivityService } from './session-activity.service';

/** TZ §7 — app → server gateway ingest (events, telemetry, raw device events, BLE state, device status). */
@Module({
  imports: [TelemetryModule, CarrierModule, AuthModule, ReplacedDeviceReviewModule],
  controllers: [IngestController],
  providers: [
    IngestService,
    IngestRepository,
    DeviceEventsService,
    SessionActivityService,
    // D-161 — touches DriverSession.lastSeenAt on authenticated driver traffic (throttled, best-effort).
    { provide: APP_INTERCEPTOR, useClass: DriverActivityInterceptor },
  ],
  exports: [IngestService, IngestRepository, SessionActivityService],
})
export class IngestModule {}
