import { Module, OnModuleInit } from '@nestjs/common';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { TripsController } from './trips.controller';
import { TripsRepository } from './trips.repository';
import { TripsService } from './trips.service';

/** TZ §11.5 — dispatch & trip lifecycle. */
@Module({
  controllers: [TripsController],
  providers: [TripsService, TripsRepository],
  exports: [TripsService, TripsRepository],
})
export class TripsModule implements OnModuleInit {
  constructor(
    private readonly snapshots: AuditSnapshotRegistry,
    private readonly repo: TripsRepository,
  ) {}

  /** TZ §18 — `before` snapshot for `@Audit({ object: 'Trip' })`; on the hard DELETE it is the
   * only record of what the removed trip looked like. */
  onModuleInit(): void {
    this.snapshots.register('Trip', (id) => this.repo.getWithStops(id));
  }
}
