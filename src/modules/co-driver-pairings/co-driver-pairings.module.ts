import { Module, OnModuleInit } from '@nestjs/common';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { DriversModule } from '../drivers/drivers.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { CoDriverPairingsController } from './co-driver-pairings.controller';
import { CoDriverPairingsRepository } from './co-driver-pairings.repository';
import { CoDriverPairingsService } from './co-driver-pairings.service';

/** §20 B-7 — one-directional on `DriversModule`/`VehiclesModule` (existence checks only);
 * neither imports this module back. */
@Module({
  imports: [DriversModule, VehiclesModule],
  controllers: [CoDriverPairingsController],
  providers: [CoDriverPairingsService, CoDriverPairingsRepository],
  exports: [CoDriverPairingsService, CoDriverPairingsRepository],
})
export class CoDriverPairingsModule implements OnModuleInit {
  constructor(
    private readonly snapshots: AuditSnapshotRegistry,
    private readonly repo: CoDriverPairingsRepository,
  ) {}

  /** TZ §18 — lets `AuditInterceptor` fetch `before`/`after` for `@Audit({ object: 'CoDriverPairing' })`. */
  onModuleInit(): void {
    this.snapshots.register('CoDriverPairing', (id) => this.repo.findById(id));
  }
}
