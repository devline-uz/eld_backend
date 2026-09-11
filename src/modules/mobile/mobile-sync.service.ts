import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { HOS_ENGINE_VERSION } from '../hos/hos.constants';
import { LogsService } from '../logs/logs.service';
import { DEFAULT_DUTY_STATUS_ANNOTATION, MAX_SYNC_BYTES, MAX_SYNC_CHANGES, SyncChangeDto, SyncRequestDto } from './dto/mobile.dto';
import { MobileDvirService } from './mobile-dvir.service';
import { MobileRepository } from './mobile.repository';
import { SYNC_CONFIG } from './mobile-bootstrap.service';

export interface SyncResult {
  accepted: string[];
  rejected: Array<{ clientId: string; code: string; message?: string }>;
  serverChanges: unknown[];
  serverTime: string;
  hosEngineVersion: string;
  nextSyncAfterSec: number;
}

/**
 * TZ §13.4/13.6 — `POST /mobile/sync`. Every queued change is applied EXACTLY ONCE by
 * `clientId` and never silently dropped: it ends up in exactly one of `accepted` / `rejected`,
 * and a `SyncedChange` row records which (§13.6 "same clientId twice → idempotent").
 *
 * Changes are processed in `occurredAt` order, not submission order — §13.6's "two devices,
 * latest `occurredAt` wins" only makes sense if the batch itself is chronological, and the
 * underlying RODS/HOS mutations (`LogsService`) already reject anything that violates
 * §395.30(c)(2) driving-time immutability, so an out-of-order replay can never shorten
 * driving time even if a client sends it in the wrong order.
 */
@Injectable()
export class MobileSyncService {
  private readonly logger = new Logger(MobileSyncService.name);

  constructor(
    private readonly repo: MobileRepository,
    private readonly logs: LogsService,
    private readonly dvir: MobileDvirService,
  ) {}

  async sync(driverId: string, dto: SyncRequestDto, actor: ContextUser, now: Date = new Date()): Promise<SyncResult> {
    this.assertBatchSize(dto);

    const accepted: string[] = [];
    const rejected: Array<{ clientId: string; code: string; message?: string }> = [];

    const ordered = [...dto.changes].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

    for (const change of ordered) {
      const outcome = await this.processOne(driverId, change, actor);
      if (outcome.status === 'ACCEPTED') accepted.push(change.clientId);
      else rejected.push({ clientId: change.clientId, code: outcome.errorCode ?? ERROR_CODES.INTERNAL_ERROR, message: outcome.message });
    }

    const since = dto.lastSyncAt ?? new Date(0);
    const serverChanges = await this.buildServerChanges(driverId, since);
    await this.repo.touchLastSync(driverId, now);

    return {
      accepted,
      rejected,
      serverChanges,
      serverTime: now.toISOString(),
      hosEngineVersion: HOS_ENGINE_VERSION,
      nextSyncAfterSec: SYNC_CONFIG.onlineIntervalSec,
    };
  }

  private async processOne(
    driverId: string,
    change: SyncChangeDto,
    actor: ContextUser,
  ): Promise<{ status: 'ACCEPTED' | 'REJECTED'; errorCode: string | null; message?: string }> {
    // §13.6 — same clientId twice: idempotent, the first outcome wins, nothing is re-applied.
    const existing = await this.repo.findSyncedByClientId(driverId, change.clientId);
    if (existing) {
      return { status: existing.status, errorCode: existing.errorCode };
    }

    let status: 'ACCEPTED' | 'REJECTED' = 'ACCEPTED';
    let errorCode: string | null = null;
    let message: string | undefined;
    let result: Record<string, unknown> | undefined;

    try {
      result = (await this.dispatch(driverId, change, actor)) as Record<string, unknown>;
    } catch (err) {
      status = 'REJECTED';
      if (err instanceof AppException) {
        errorCode = err.code;
        message = err.message;
      } else {
        errorCode = ERROR_CODES.INTERNAL_ERROR;
        message = 'Unexpected error while applying the queued change.';
        this.logger.error({ err, clientId: change.clientId, type: change.type }, 'Sync change failed with a non-AppException error');
      }
    }

    const recorded = await this.repo.recordSyncedResult(
      driverId,
      change.clientId,
      change.type,
      change.occurredAt,
      status,
      errorCode,
      result as Prisma.InputJsonValue | undefined,
    );
    if (recorded === 'DUPLICATE') {
      // Lost a race against a concurrent replay of the same clientId — its outcome is authoritative.
      const settled = await this.repo.findSyncedByClientId(driverId, change.clientId);
      return { status: settled?.status ?? status, errorCode: settled?.errorCode ?? errorCode };
    }
    return { status: recorded.status, errorCode: recorded.errorCode, message };
  }

  private dispatch(driverId: string, change: SyncChangeDto, actor: ContextUser): Promise<unknown> {
    switch (change.type) {
      case 'duty_status':
        return this.logs.createLogEntry(
          driverId,
          { ...change.payload, annotation: change.payload.annotation ?? DEFAULT_DUTY_STATUS_ANNOTATION },
          actor,
        );
      case 'log_entry':
        return this.logs.createLogEntry(driverId, change.payload, actor);
      case 'certify':
        return this.logs.certify({ dates: change.payload.dates, signatureImageId: change.payload.signatureImageId, driverId: undefined }, actor);
      case 'dvir':
        return this.dvir.submit(driverId, change.payload, actor);
      default: {
        const exhaustive: never = change;
        throw new AppException(ERROR_CODES.SYNC_UNKNOWN_CHANGE_TYPE, 'Unknown sync change type.', 422, {
          type: (exhaustive as SyncChangeDto).type,
        });
      }
    }
  }

  /** §13.4 `serverChanges` — RODS records the app does not have yet since `lastSyncAt`. */
  private async buildServerChanges(driverId: string, since: Date) {
    const events = await this.repo.findEventsSince(driverId, since);
    return events.map((event) => ({
      id: String(event.id),
      eventType: event.eventType,
      eventCode: event.eventCode,
      eventDateTime: event.eventDateTime,
      recordStatus: event.recordStatus,
      recordOrigin: event.recordOrigin,
      annotation: event.annotation,
      supersedesId: event.supersedesId === null ? null : String(event.supersedesId),
    }));
  }

  private assertBatchSize(dto: SyncRequestDto): void {
    if (dto.changes.length > MAX_SYNC_CHANGES) {
      throw new AppException(ERROR_CODES.SYNC_BATCH_TOO_LARGE, `Batch exceeds ${MAX_SYNC_CHANGES} changes.`, 413, {
        received: dto.changes.length,
        max: MAX_SYNC_CHANGES,
      });
    }
    const bytes = Buffer.byteLength(JSON.stringify(dto.changes));
    if (bytes > MAX_SYNC_BYTES) {
      throw new AppException(ERROR_CODES.SYNC_BATCH_TOO_LARGE, 'Batch exceeds 1 MB.', 413, { receivedBytes: bytes, maxBytes: MAX_SYNC_BYTES });
    }
  }
}
