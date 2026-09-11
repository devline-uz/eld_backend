import { Module, OnModuleInit } from '@nestjs/common';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { CarrierController } from './carrier.controller';
import { CarrierRepository } from './carrier.repository';
import { CarrierService } from './carrier.service';

@Module({
  controllers: [CarrierController],
  providers: [CarrierService, CarrierRepository],
  exports: [CarrierService, CarrierRepository],
})
export class CarrierModule implements OnModuleInit {
  constructor(
    private readonly snapshots: AuditSnapshotRegistry,
    private readonly repo: CarrierRepository,
  ) {}

  /** TZ §18 — lets `AuditInterceptor` fetch `before`/`after` for `@Audit({ object: 'Carrier' })`. */
  onModuleInit(): void {
    this.snapshots.register('Carrier', (id) => this.repo.findById(id));
  }
}
