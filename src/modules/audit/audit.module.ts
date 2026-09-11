import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

/**
 * `before`/`after` (TZ §18, D-002) are wired for every mandatory op this module currently
 * owns: role create/update/delete, user invite/update/delete, API key create/revoke. Later
 * phases (log edit, certification, unit deletion, odometer calibration, data transfer, report
 * export, carrier settings) plug into the same mechanism with no changes here:
 *   1. Put `@Audit({ object: 'Whatever', action: 'VERB' })` on the mutation route, same as
 *      `RolesController`/`UsersController`/`ApiKeysController`.
 *   2. In that feature's own module, `implements OnModuleInit` and call
 *      `AuditSnapshotRegistry.register('Whatever', (id) => repo.findById(...))` — see
 *      `RolesModule`/`UsersModule`/`ApiKeysModule` for the pattern. CREATE/DELETE need no
 *      special-casing: the interceptor already treats "no row found" as `before/after = null`.
 *   3. If the entity carries a secret-shaped field, add its name to
 *      `AUDIT_REDACTED_FIELDS` in `common/audit/redact.ts`.
 */
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditRepository],
  // `AuditRepository` is exported for the mandatory, non-interceptor audit writes: a RODS log
  // edit, a certification and an unidentified-driving assignment must record actor + before +
  // after inside the same service call that performs them (TZ §9, §7.4, §18).
  exports: [AuditService, AuditRepository],
})
export class AuditModule {}
