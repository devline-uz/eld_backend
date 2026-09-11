import { Module } from '@nestjs/common';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { DtcController } from './dtc.controller';
import { DtcRepository } from './dtc.repository';
import { DtcService } from './dtc.service';

/**
 * TZ §5.7 — DTC capture (from `TelemetryModule`, imported one-directionally there — see
 * `telemetry.module.ts`) and the read-side `GET /vehicles/:id/dtc` endpoint (needs
 * `VehiclesModule` only to 404 on an unknown unit, matching the `VehiclesModule ->
 * DriversModule` one-directional pattern).
 */
@Module({
  imports: [VehiclesModule],
  controllers: [DtcController],
  providers: [DtcRepository, DtcService],
  exports: [DtcService],
})
export class DtcModule {}
