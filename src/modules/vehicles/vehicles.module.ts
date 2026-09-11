import { Module, OnModuleInit } from '@nestjs/common';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { DriversModule } from '../drivers/drivers.module';
import { TrailersController } from './trailers.controller';
import { TrailersRepository } from './trailers.repository';
import { TrailersService } from './trailers.service';
import { VehiclesController } from './vehicles.controller';
import { VehiclesRepository } from './vehicles.repository';
import { VehiclesService } from './vehicles.service';

/**
 * TZ §5.3 — one-directional dependency on `DriversModule` (assign/unassign-driver needs
 * `DriversRepository`). Never the reverse: keeps the module graph acyclic instead of using
 * `forwardRef`, and matches the DVIR out-of-service rule living on the vehicle, not the driver.
 */
@Module({
  imports: [DriversModule],
  controllers: [VehiclesController, TrailersController],
  providers: [VehiclesService, VehiclesRepository, TrailersService, TrailersRepository],
  exports: [VehiclesService, VehiclesRepository],
})
export class VehiclesModule implements OnModuleInit {
  constructor(
    private readonly snapshots: AuditSnapshotRegistry,
    private readonly vehiclesRepo: VehiclesRepository,
    private readonly trailersRepo: TrailersRepository,
  ) {}

  /** TZ §18 — snapshot loaders for `@Audit({ object: 'Vehicle' | 'Trailer' })`. */
  onModuleInit(): void {
    this.snapshots.register('Vehicle', (id) => this.vehiclesRepo.findById({ id }));
    this.snapshots.register('Trailer', (id) => this.trailersRepo.findById({ id }));
  }
}
