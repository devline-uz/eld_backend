import { Module, OnModuleInit } from '@nestjs/common';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { DevicesController } from './devices.controller';
import { DevicesRepository } from './devices.repository';
import { DevicesService } from './devices.service';

/** One-directional dependency on `VehiclesModule` (pairing needs `VehiclesRepository`) — mirrors
 * `VehiclesModule -> DriversModule`, keeping the fleet module graph acyclic. */
@Module({
  imports: [VehiclesModule],
  controllers: [DevicesController],
  providers: [DevicesService, DevicesRepository],
  exports: [DevicesService, DevicesRepository],
})
export class DevicesModule implements OnModuleInit {
  constructor(
    private readonly snapshots: AuditSnapshotRegistry,
    private readonly repo: DevicesRepository,
  ) {}

  /** TZ §18 — lets `AuditInterceptor` fetch `before`/`after` for `@Audit({ object: 'Device' })`. */
  onModuleInit(): void {
    this.snapshots.register('Device', (id) => this.repo.findById({ id }));
  }
}
