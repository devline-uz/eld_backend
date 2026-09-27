import { forwardRef, Module } from '@nestjs/common';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { DtcController } from './dtc.controller';
import { DtcRepository } from './dtc.repository';
import { DtcService } from './dtc.service';

/**
 * TZ §5.7 — DTC capture (from `TelemetryModule`, imported one-directionally there — see
 * `telemetry.module.ts`) and the read-side `GET /vehicles/:id/dtc` endpoint (needs
 * `VehiclesModule` only to 404 on an unknown unit, matching the `VehiclesModule ->
 * DriversModule` one-directional pattern).
 *
 * B-101/B-102-adjacent (2026-09-24): `VehiclesModule -> MobileModule -> LogsModule ->
 * IngestModule -> TelemetryModule -> DtcModule -> VehiclesModule` is a real module cycle
 * (both sides import the *service*, not just the type), which CommonJS resolves by handing
 * one side an `undefined` module reference mid-evaluation — Nest then throws "The module at
 * index [0] of the DtcModule imports array is undefined" the moment anything boots the full
 * `AppModule` graph (every e2e spec). `forwardRef()` on both ends of this one edge defers
 * the lookup until both modules have finished registering.
 */
@Module({
  imports: [forwardRef(() => VehiclesModule)],
  controllers: [DtcController],
  providers: [DtcRepository, DtcService],
  exports: [DtcService],
})
export class DtcModule {}
