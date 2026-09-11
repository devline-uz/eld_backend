import { Module, OnModuleInit } from '@nestjs/common';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { AuthModule } from '../auth/auth.module';
import { RolesModule } from '../roles/roles.module';
import { MeController } from './me.controller';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  imports: [AuthModule, RolesModule],
  controllers: [UsersController, MeController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService, UsersRepository],
})
export class UsersModule implements OnModuleInit {
  constructor(
    private readonly snapshots: AuditSnapshotRegistry,
    private readonly repo: UsersRepository,
  ) {}

  /** TZ §18 — lets `AuditInterceptor` fetch `before`/`after` for `@Audit({ object: 'User' })`.
   * `passwordHash`/`twoFactorSecret`/`recoveryCodes` are redacted downstream, not filtered
   * here, so the snapshot loader can stay a plain read. */
  onModuleInit(): void {
    this.snapshots.register('User', (id) => this.repo.findByIdWithRole(id));
  }
}
