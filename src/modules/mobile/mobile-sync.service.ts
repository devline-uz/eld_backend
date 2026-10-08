import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { EditorType } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { RequestContext, type ContextUser } from '../../core/context/request-context';
import { AuditRepository } from '../audit/audit.repository';
import { EventBusService } from '../../core/events/event-bus.service';
import { QUEUES } from '../../core/queue/queue.constants';
import { HOS_ENGINE_VERSION } from '../hos/hos.constants';
import { LogsService } from '../logs/logs.service';
import { DEFAULT_DUTY_STATUS_ANNOTATION, MAX_SYNC_BYTES, MAX_SYNC_CHANGES, SyncChangeDto, SyncRequestDto } from './dto/mobile.dto';
import { MobileDvirService } from './mobile-dvir.service';
import { MobileRepository } from './mobile.repository';
import { SYNC_CONFIG } from './mobile-bootstrap.service';
import { SignatureService } from './signature.service';

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
/** MR-25 — device clock tolerance for a delegated change's timestamps. */
const DELEGATION_CLOCK_SKEW_MS = 5 * 60_000;

/** MR-25 — why a change may be applied to another driver (feeds the AuditLog row). */
interface DelegationGrant {
  target: string;
  pairingId: string | null;
  vehicleId: string | null;
  evidence: 'CO_DRIVER_PAIRING' | 'ELD_LOGIN_SESSION';
}

@Injectable()
export class MobileSyncService {
  private readonly logger = new Logger(MobileSyncService.name);

  /** MB-11 — "idempotent per driver per day if easy": no dedicated table for this warning
   *  alert, so a same-process, same-day de-dupe is enough (worst case after a restart is one
   *  extra alert, never a missed one). Bounded so a long-lived process cannot leak memory. */
  private readonly backlogAlertedToday = new Map<string, string>();

  constructor(
    private readonly repo: MobileRepository,
    private readonly logs: LogsService,
    private readonly dvir: MobileDvirService,
    private readonly signatures: SignatureService,
    private readonly events: EventBusService,
    @InjectQueue(QUEUES.ALERT) private readonly alertQueue: Queue,
    @Optional() private readonly audit?: AuditRepository,
  ) {}

  async sync(driverId: string, dto: SyncRequestDto, actor: ContextUser, now: Date = new Date()): Promise<SyncResult> {
    this.assertBatchSize(dto);
    await this.checkBacklog(driverId, dto.backlog, now);

    const accepted: string[] = [];
    const rejected: Array<{ clientId: string; code: string; message?: string }> = [];

    const ordered = [...dto.changes].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

    for (const change of ordered) {
      const outcome = await this.processOne(driverId, change, actor, now);
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
    now: Date,
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
      result = (await this.dispatch(driverId, change, actor, now)) as Record<string, unknown>;
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

  private async dispatch(driverId: string, change: SyncChangeDto, actor: ContextUser, now: Date): Promise<unknown> {
    const grant = await this.resolveTargetDriver(driverId, change, now);
    const target = grant?.target ?? driverId;
    switch (change.type) {
      case 'duty_status': {
        const result = await this.logs.createLogEntry(
          target,
          { ...change.payload, annotation: change.payload.annotation ?? DEFAULT_DUTY_STATUS_ANNOTATION },
          actor,
        );
        if (grant) await this.auditDelegation(driverId, change, grant, actor);
        return result;
      }
      case 'log_entry': {
        const result = await this.logs.createLogEntry(target, change.payload, actor);
        if (grant) await this.auditDelegation(driverId, change, grant, actor);
        return result;
      }
      case 'certify': {
        // MB-8 — offline certification has no `signatureImageId` yet (that id is only minted
        // by `POST /mobile/signature`, which needs the network): store the captured bytes
        // through the same `SignatureService` (purpose CERTIFICATION) right here instead.
        let signatureImageId = change.payload.signatureImageId;
        if (!signatureImageId && change.payload.signatureBase64) {
          const stored = await this.signatures.store('signatures', driverId, change.payload.signatureBase64, change.payload.signatureMimeType);
          signatureImageId = stored.id;
        }
        return this.logs.certify({ dates: change.payload.dates, signatureImageId, driverId: undefined }, actor);
      }
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

  /**
   * MR-25 — shared tablet. A change may name another `driverId` only when:
   *   - it is a duty-status / log-entry change (certification and DVIR carry the signer's own
   *     signature, §395.30(b) / §396.11 — never delegated) that ADDS a record: `originalEventId`
   *     (correcting one of the other driver's existing records) is never delegated;
   *   - that driver exists, is ACTIVE and not deleted (single-carrier deployment, so no
   *     cross-carrier reach is possible; a foreign id simply does not exist);
   *   - `occurredAt` and the record's `startAt` lie inside the offline window (not older than
   *     `SYNC_CONFIG.localEventRetentionDays`, not more than 5 min in the future);
   *   - the two drivers shared one unit over the WHOLE record interval `[startAt, endAt ?? startAt]`
   *     (bugs.md B-118 — the client-chosen `occurredAt` proves nothing): one co-driver pairing
   *     covering both ends, or both logged in to the same unit at both ends per their §395 login
   *     records (eventType 5). Team driving on one device is the only §395 setting where another
   *     driver's record is entered here.
   * Anything else rejects THIS change only (`SYNC_DELEGATION_NOT_ALLOWED`); the batch goes on.
   * The record keeps `editedById` = the token's driver; the AuditLog row naming both drivers is
   * written by `dispatch` only after the change was actually applied.
   */
  private async resolveTargetDriver(driverId: string, change: SyncChangeDto, now: Date): Promise<DelegationGrant | null> {
    const requested = change.driverId;
    if (!requested || requested === driverId) return null;
    const reject = (reason: string): never => {
      throw new AppException(ERROR_CODES.SYNC_DELEGATION_NOT_ALLOWED, `This change cannot be applied for another driver: ${reason}.`, 403, {
        driverId: requested,
        reason,
      });
    };
    if (change.type !== 'duty_status' && change.type !== 'log_entry') {
      return reject('only duty_status and log_entry may be delegated');
    }
    const payload = change.payload;
    if (payload.originalEventId) reject("another driver's existing records cannot be corrected from this device");

    const oldest = now.getTime() - SYNC_CONFIG.localEventRetentionDays * 86_400_000;
    const newest = now.getTime() + DELEGATION_CLOCK_SKEW_MS;
    const from = payload.startAt;
    const to = payload.endAt ?? payload.startAt;
    for (const at of [change.occurredAt, from, to]) {
      if (at.getTime() < oldest || at.getTime() > newest) reject('occurredAt / startAt / endAt outside the offline sync window');
    }

    const other = await this.repo.findDriver(requested);
    if (!other || other.deletedAt || other.status !== 'ACTIVE') reject('no session or assignment shared on this unit at that time');

    // Evidence of a shared unit over the whole record: a co-driver pairing (one unit,
    // time-bounded) covering both ends, else both drivers' §395 login records on one unit.
    const pairing = await this.repo.findPairingCovering(driverId, requested, from);
    if (pairing && (!pairing.endedAt || pairing.endedAt.getTime() >= to.getTime())) {
      return { target: requested, pairingId: pairing.id, vehicleId: pairing.vehicleId, evidence: 'CO_DRIVER_PAIRING' };
    }
    const [mineFrom, theirsFrom, mineTo, theirsTo] = await Promise.all([
      this.repo.findLoginVehicleAt(driverId, from),
      this.repo.findLoginVehicleAt(requested, from),
      this.repo.findLoginVehicleAt(driverId, to),
      this.repo.findLoginVehicleAt(requested, to),
    ]);
    if (!mineFrom || ![theirsFrom, mineTo, theirsTo].every((vehicle) => vehicle === mineFrom)) {
      reject('no session or assignment shared on this unit at that time');
    }
    return { target: requested, pairingId: null, vehicleId: mineFrom, evidence: 'ELD_LOGIN_SESSION' };
  }

  private async auditDelegation(driverId: string, change: SyncChangeDto, grant: DelegationGrant, actor: ContextUser): Promise<void> {
    try {
      await this.audit?.insert({
        actorId: actor.id,
        actorType: EditorType.DRIVER,
        action: 'SYNC_DELEGATED_CHANGE',
        objectType: 'Driver',
        objectId: grant.target,
        after: {
          onBehalfOfDriverId: grant.target,
          submittedByDriverId: driverId,
          pairingId: grant.pairingId,
          vehicleId: grant.vehicleId,
          evidence: grant.evidence,
          clientId: change.clientId,
          type: change.type,
          occurredAt: change.occurredAt.toISOString(),
        },
        detail: 'Shared-tablet change applied to the co-driver sharing the unit (MR-25).',
        ip: RequestContext.get()?.ip,
        userAgent: RequestContext.get()?.userAgent,
      });
    } catch (err) {
      this.logger.error({ err, clientId: change.clientId }, 'Failed to write the delegated-sync audit entry');
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

  /**
   * MB-11 — the app self-reports how far behind it is (`backlog.days`/`backlog.bytes`, its own
   * local-queue view, §13.3/§13.4). Mirrors how ingest raises `alert.device_backlog` off
   * `storedEventsCount` (§7.7): same publish + best-effort enqueue pattern, just a different
   * threshold source.
   */
  private async checkBacklog(driverId: string, backlog: SyncRequestDto['backlog'], now: Date): Promise<void> {
    if (!backlog) return;
    const overDays = backlog.days > SYNC_CONFIG.syncBacklogWarnDays;
    const overBytes = backlog.bytes > SYNC_CONFIG.syncBacklogWarnBytes;
    if (!overDays && !overBytes) return;

    const dayKey = now.toISOString().slice(0, 10);
    if (this.backlogAlertedToday.get(driverId) === dayKey) return;
    this.backlogAlertedToday.set(driverId, dayKey);

    await this.raiseAlert('alert.sync_backlog', { driverId, days: backlog.days, bytes: backlog.bytes });
  }

  private async raiseAlert(name: string, payload: Record<string, unknown>): Promise<void> {
    await this.events.publish(name, payload);
    try {
      await this.alertQueue.add(name, payload);
    } catch (err) {
      this.logger.error({ err, alert: name }, 'Failed to enqueue alert');
    }
  }
}
