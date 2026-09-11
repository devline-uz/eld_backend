import { Inject, Injectable, Logger } from '@nestjs/common';
import { EditorType } from '@prisma/client';
import { DateTime } from 'luxon';
import { Readable } from 'node:stream';
import { AuditRepository } from '../audit/audit.repository';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';
import {
  AUDIT_RETENTION_MONTHS,
  EVENT_RETENTION_MONTHS,
  RETENTION_ARCHIVE_PREFIX,
} from './retention.constants';
import { EldEventPartition, RetentionRepository } from './retention.repository';
import { RetentionPurgeService } from './retention-purge.service';

export interface EldEventRetentionResult {
  scannedPartitions: number;
  droppedPartitions: string[];
  skippedWithinWindow: number;
}

export interface AuditLogRetentionResult {
  eligible: number;
  archived: number;
  purged: number;
  skipped: boolean;
  reason?: string;
}

const SYSTEM_ACTOR_ID = 'retention.processor';

/**
 * Orchestrates TZ §5.5/§18/§23's two retention floors:
 *   - `EldEvent` ("RODS"): never drop a partition until every row in it is older than
 *     `EVENT_RETENTION_MONTHS` (24 — a superset of the 6-month FMCSA RODS minimum, see
 *     retention.constants.ts). Archive to S3, VERIFY the archive, only then DETACH+DROP.
 *   - `AuditLog`: never purge a row until it is older than `AUDIT_RETENTION_MONTHS` (24).
 *     Same archive-then-verify-then-remove shape, but the removal step is a `DELETE` run by
 *     `RetentionPurgeService`'s separate DB role, not DDL.
 *
 * Both cutoffs are computed once per sweep (`this.now()`), never passed in from outside, so
 * a caller cannot shrink the retention window by constructing an earlier "now".
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly repo: RetentionRepository,
    private readonly purge: RetentionPurgeService,
    private readonly auditRepo: AuditRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  /** Exposed for tests: the exact cutoff a sweep starting "now" would use. */
  eventCutoff(now: DateTime = DateTime.utc()): Date {
    return now.minus({ months: EVENT_RETENTION_MONTHS }).toJSDate();
  }

  auditCutoff(now: DateTime = DateTime.utc()): Date {
    return now.minus({ months: AUDIT_RETENTION_MONTHS }).toJSDate();
  }

  /** Determines which listed partitions are eligible to drop for a given cutoff, without
   * touching the DB or S3 — pure function, used directly by the boundary unit tests. */
  static partitionsEligibleForDrop(
    partitions: EldEventPartition[],
    cutoff: Date,
  ): EldEventPartition[] {
    // Only a partition whose *entire* range (up to rangeEnd, exclusive) is at or before the
    // cutoff is eligible — a partition that still holds even one in-window row must survive.
    return partitions.filter((p) => p.rangeEnd.getTime() <= cutoff.getTime());
  }

  async sweepEldEvent(now: DateTime = DateTime.utc()): Promise<EldEventRetentionResult> {
    const cutoff = this.eventCutoff(now);
    const partitions = await this.repo.listEldEventPartitions();
    const eligible = RetentionService.partitionsEligibleForDrop(partitions, cutoff);
    const dropped: string[] = [];
    for (const partition of eligible) {
      try {
        const ok = await this.archiveAndDropPartition(partition);
        if (ok) dropped.push(partition.name);
      } catch (err) {
        this.logger.error({ err, partition: partition.name }, 'EldEvent partition retention step failed — left in place');
      }
    }
    return {
      scannedPartitions: partitions.length,
      droppedPartitions: dropped,
      skippedWithinWindow: partitions.length - eligible.length,
    };
  }

  private async archiveAndDropPartition(partition: EldEventPartition): Promise<boolean> {
    const dbCountBefore = await this.repo.countPartitionRows(partition.name);
    if (dbCountBefore === 0) {
      // Nothing to archive; still safe to drop an empty partition (e.g. a month with no
      // events). Skip the archive step entirely rather than uploading an empty object.
      await this.repo.detachAndDropPartition(partition.name);
      await this.recordAction('RETENTION_DROP_PARTITION', 'EldEvent', partition.name, 'rows=0 archive=skipped');
      return true;
    }

    const key = `${RETENTION_ARCHIVE_PREFIX}/eldevent/${partition.name}.ndjson`;
    const { count: archivedCount, sizeBytes } = await this.archiveToS3(key, this.repo.streamPartitionRows(partition.name));

    const verified = await this.verifyArchive(key, archivedCount, dbCountBefore, sizeBytes);
    if (!verified) {
      this.logger.error(
        { partition: partition.name, dbCountBefore, archivedCount, key },
        'Archive verification failed — refusing to drop EldEvent partition',
      );
      return false;
    }

    await this.repo.detachAndDropPartition(partition.name);
    await this.recordAction(
      'RETENTION_DROP_PARTITION',
      'EldEvent',
      partition.name,
      `rows=${archivedCount} archiveKey=${key}`,
    );
    return true;
  }

  async sweepAuditLog(now: DateTime = DateTime.utc()): Promise<AuditLogRetentionResult> {
    const cutoff = this.auditCutoff(now);
    const eligible = await this.repo.countAuditLogOlderThan(cutoff);
    if (eligible === 0) {
      return { eligible: 0, archived: 0, purged: 0, skipped: false };
    }
    if (!this.purge.isConfigured) {
      this.logger.warn(
        { eligible },
        'AuditLog retention: rows are past the 24-month floor but RETENTION_DATABASE_URL is ' +
          'unset — archiving is skipped and NO purge is attempted (never falls back to the app role).',
      );
      return { eligible, archived: 0, purged: 0, skipped: true, reason: 'RETENTION_DATABASE_URL not configured' };
    }

    const key = `${RETENTION_ARCHIVE_PREFIX}/auditlog/${DateTime.utc().toFormat('yyyyLLdd-HHmmss')}.ndjson`;
    const { count: archivedCount, sizeBytes } = await this.archiveToS3(key, this.repo.streamAuditLogOlderThan(cutoff));
    const verified = await this.verifyArchive(key, archivedCount, eligible, sizeBytes);
    if (!verified) {
      this.logger.error({ eligible, archivedCount, key }, 'Archive verification failed — refusing to purge AuditLog');
      return { eligible, archived: archivedCount, purged: 0, skipped: true, reason: 'archive verification failed' };
    }

    const purged = await this.purge.purgeOlderThan(cutoff);
    await this.recordAction('RETENTION_PURGE_AUDIT_LOG', 'AuditLog', key, `rows=${purged} archiveKey=${key}`);
    return { eligible, archived: archivedCount, purged, skipped: false };
  }

  private async archiveToS3(
    key: string,
    rows: AsyncGenerator<Record<string, unknown>[]>,
  ): Promise<{ count: number; sizeBytes: number }> {
    let count = 0;
    const readable = new Readable({ read() {} });
    const pump = (async () => {
      try {
        for await (const batch of rows) {
          for (const row of batch) {
            count += 1;
            readable.push(`${JSON.stringify(row, jsonBigIntReplacer)}\n`);
          }
        }
        readable.push(null);
      } catch (err) {
        readable.destroy(err as Error);
      }
    })();
    if (!this.storage.putStream) {
      throw new Error('StoragePort.putStream is required for retention archiving');
    }
    const [{ sizeBytes }] = await Promise.all([this.storage.putStream(key, readable, { contentType: 'application/x-ndjson' }), pump]);
    return { count, sizeBytes };
  }

  /** "Confirmed" (tz.md §5.5: "arxiv nusxasi tasdiqlanadi") means: the object exists in S3,
   * has non-zero size once at least one row was archived, and the row count streamed into
   * the archive matches the row count read from the DB immediately before archiving. */
  private async verifyArchive(key: string, archivedCount: number, dbCount: number, sizeBytes: number): Promise<boolean> {
    if (archivedCount !== dbCount) return false;
    if (sizeBytes <= 0) return false;
    return this.storage.exists(key);
  }

  private async recordAction(action: string, objectType: string, objectId: string, detail: string): Promise<void> {
    try {
      await this.auditRepo.insert({
        actorId: SYSTEM_ACTOR_ID,
        actorType: EditorType.SYSTEM,
        action,
        objectType,
        objectId,
        detail,
      });
    } catch (err) {
      this.logger.error({ err, action, objectId }, 'Failed to write retention AuditLog entry (drop/purge already happened)');
    }
  }
}

function jsonBigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
