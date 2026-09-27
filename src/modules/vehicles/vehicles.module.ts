import { forwardRef, Module, OnModuleInit } from '@nestjs/common';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { CarrierModule } from '../carrier/carrier.module';
import { DriversModule } from '../drivers/drivers.module';
import { MobileModule } from '../mobile/mobile.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TransfersModule } from '../transfers/transfers.module';
import { UsersModule } from '../users/users.module';
import { TrailersController } from './trailers.controller';
import { TrailersRepository } from './trailers.repository';
import { TrailersService } from './trailers.service';
import { VehicleGroupsController } from './vehicle-groups.controller';
import { VehicleGroupsRepository } from './vehicle-groups.repository';
import { VehicleGroupsService } from './vehicle-groups.service';
import { VehiclesController } from './vehicles.controller';
import { VehiclesRepository } from './vehicles.repository';
import { VehiclesService } from './vehicles.service';

/**
 * TZ §5.3 — one-directional dependency on `DriversModule` (assign/unassign-driver needs
 * `DriversRepository`). Never the reverse: keeps the module graph acyclic instead of using
 * `forwardRef`, and matches the DVIR out-of-service rule living on the vehicle, not the driver.
 * `NotificationsModule` (B-74 notify), `CarrierModule` (histories day-boundary fallback tz),
 * `UsersModule`/`TransfersModule` (B-69 `emailSummary`), `MobileModule` (FCM push on
 * assign-driver — reads `MobileRepository.findPushTokens`, never imports `VehiclesModule`
 * back) are all one-directional the same way — none of them import `VehiclesModule` back.
 * Telemetry reads (B-4 histories, telemetry read
 * path) do NOT import `TelemetryModule` — that would cycle through `TelemetryModule ->
 * DtcModule -> VehiclesModule` — so `VehiclesRepository` queries `TelemetryPoint` directly,
 * same pattern as `findOpenCriticalDefectIds`/`findAuditRows`/`findDvirRows`.
 */
@Module({
  // B-105/B-108-adjacent (2026-09-24): MobileModule sits on the VehiclesModule -> MobileModule
  // -> LogsModule -> IngestModule -> TelemetryModule -> DtcModule -> VehiclesModule cycle
  // (DtcModule's side already uses forwardRef — see dtc.module.ts). Which side of a CommonJS
  // circular require ends up `undefined` depends on which module is required first, and the
  // worker process (`worker.ts` -> WorkersModule -> ServiceModule -> ... -> VehiclesModule)
  // enters this graph from a different starting point than the API process (`main.ts` ->
  // AppModule -> VehiclesModule directly), so the API could boot fine while the worker threw
  // "The module at index [5] of the VehiclesModule imports array is undefined" (MobileModule).
  // forwardRef() on both ends of the one edge that closes the loop is required, not optional.
  imports: [
    DriversModule,
    NotificationsModule,
    CarrierModule,
    UsersModule,
    TransfersModule,
    forwardRef(() => MobileModule),
  ],
  controllers: [VehiclesController, TrailersController, VehicleGroupsController],
  providers: [VehiclesService, VehiclesRepository, TrailersService, TrailersRepository, VehicleGroupsService, VehicleGroupsRepository],
  exports: [VehiclesService, VehiclesRepository],
})
export class VehiclesModule implements OnModuleInit {
  constructor(
    private readonly snapshots: AuditSnapshotRegistry,
    private readonly vehiclesRepo: VehiclesRepository,
    private readonly trailersRepo: TrailersRepository,
    private readonly groupsRepo: VehicleGroupsRepository,
  ) {}

  /** TZ §18 — snapshot loaders for `@Audit({ object: 'Vehicle' | 'Trailer' })`. */
  onModuleInit(): void {
    this.snapshots.register('Vehicle', (id) => this.vehiclesRepo.findById({ id }));
    this.snapshots.register('Trailer', (id) => this.trailersRepo.findById({ id }));
    this.snapshots.register('VehicleGroup', (id) => this.groupsRepo.findById({ id }));
  }
}
