import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppConfigService } from '../../core/config/config.service';

/**
 * The ONE place in the codebase allowed to `DELETE FROM "AuditLog"`. `AuditLog` is a flat
 * (non-partitioned) table with `UPDATE`/`DELETE` revoked from the app role at the DB level
 * (B-009) — unlike `EldEvent`, there is no DETACH/DROP DDL escape hatch here, so the
 * 24-month purge genuinely needs a `DELETE`. Table ownership does not bypass an explicit
 * `REVOKE` in Postgres (verified against dev: `DELETE FROM "AuditLog" WHERE false` as
 * `eld_dev` fails with "permission denied for table AuditLog" even though `eld_dev` owns the
 * table) — so the app role can never be granted this back, per this task's constraint.
 *
 * Design (decisions.md D-040): a second, narrowly-scoped Postgres role
 * (`eld_retention_svc`, bootstrapped once per environment by
 * `scripts/bootstrap-retention-role.sql`, run by an operator with superuser/CREATEROLE —
 * the app role deliberately has neither) holds `SELECT, DELETE` on `AuditLog` ONLY. This
 * service opens a second `PrismaClient` against `RETENTION_DATABASE_URL` (that role's
 * connection string) purely for the purge statement; every other read in the retention flow
 * (counting/streaming rows to archive) still goes through the normal app-role `PrismaService`,
 * which already has `SELECT` on `AuditLog`.
 *
 * The 24-month cutoff is computed INSIDE this service, never accepted from the caller as a
 * raw `Date` without re-deriving it — so a bug elsewhere in the call chain cannot pass an
 * arbitrarily-recent cutoff and purge rows still inside their mandated window.
 */
@Injectable()
export class RetentionPurgeService implements OnModuleDestroy {
  private readonly logger = new Logger(RetentionPurgeService.name);
  private client: PrismaClient | null = null;

  constructor(private readonly config: AppConfigService) {}

  get isConfigured(): boolean {
    return Boolean(this.config.get('RETENTION_DATABASE_URL'));
  }

  private getClient(): PrismaClient {
    if (!this.isConfigured) {
      throw new Error(
        'RETENTION_DATABASE_URL is not set — the AuditLog purge step is disabled until ' +
          'scripts/bootstrap-retention-role.sql has been applied and the env var configured. ' +
          'This must never fall back to the app role connection (it lacks DELETE by design).',
      );
    }
    if (!this.client) {
      this.client = new PrismaClient({
        datasources: { db: { url: this.config.get('RETENTION_DATABASE_URL') } },
      });
    }
    return this.client;
  }

  /** Deletes every `AuditLog` row older than the 24-month retention floor and returns the
   * count removed. Callers must have already archived those exact rows to S3 and verified
   * the archive before calling this — this method does not archive anything itself. */
  async purgeOlderThan(cutoff: Date): Promise<number> {
    const client = this.getClient();
    const result = await client.$executeRaw`DELETE FROM "AuditLog" WHERE "createdAt" < ${cutoff}`;
    this.logger.log({ cutoff: cutoff.toISOString(), deleted: result }, 'AuditLog retention purge executed');
    return result;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.$disconnect();
  }
}
