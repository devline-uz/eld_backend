import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { EditorType, type EldEvent, type Prisma, type UnidentifiedSegment } from '@prisma/client';
import { Queue } from 'bullmq';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { RequestContext } from '../../core/context/request-context';
import { EventBusService } from '../../core/events/event-bus.service';
import { QUEUES } from '../../core/queue/queue.constants';
import { AuditRepository } from '../audit/audit.repository';
import { dayKey } from '../hos/engine/timezone';
import { RECORD_ORIGIN, RECORD_STATUS } from '../ingest/event-codes';
import type { AppendRow } from '../logs/edit-plan';
import { LogsService } from '../logs/logs.service';
import { RodsEventWriter } from '../logs/rods-event-writer';
import {
  AnnotateUnidentifiedDto,
  AssignUnidentifiedDto,
  ConfirmUnidentifiedDto,
  RejectUnidentifiedDto,
  UnidentifiedListQueryDto,
} from './dto/unidentified.dto';
import { UnidentifiedRepository } from './unidentified.repository';

/**
 * TZ §5.9 / §7.4 / §23 — unidentified driving.
 *
 * Two invariants dominate this file:
 *   1. `recordOrigin` of an assigned record is `1` (automatically recorded by the ELD) and is
 *      NEVER `2`. Attribution does not make a record driver-entered (§23, §7.4). Rejecting an
 *      assignment puts the records back in the pool as `recordOrigin = 4`, `driverId = null`.
 *   2. Device-stored events are never lost. `EldEvent` is append-only, so assignment appends
 *      an attributed copy and an "Inactive — Changed" marker; the original row, with its
 *      original `eventSequenceId` and checksum, stays in the table forever (§23).
 */
@Injectable()
export class UnidentifiedService {
  private readonly logger = new Logger(UnidentifiedService.name);

  constructor(
    private readonly repo: UnidentifiedRepository,
    private readonly writer: RodsEventWriter,
    private readonly audit: AuditRepository,
    private readonly events: EventBusService,
    @InjectQueue(QUEUES.HOS_RECALC) private readonly hosRecalcQueue: Queue,
    private readonly logs: LogsService,
  ) {}

  async list(query: UnidentifiedListQueryDto) {
    const where: Prisma.UnidentifiedSegmentWhereInput = {
      ...(query.status !== 'ALL' && { status: query.status }),
      ...(query.vehicleId && { vehicleId: query.vehicleId }),
      ...(query.from && { endAt: { gte: query.from } }),
      ...(query.to && { startAt: { lte: query.to } }),
    };
    const page = await this.repo.listSegments(where, query.page, query.limit);
    return { ...page, items: page.items.map((item) => this.toView(item)) };
  }

  async get(id: string) {
    const segment = await this.requireSegment(id);
    const events = await this.repo.findEventsByIds(segment.eventIds);
    return {
      ...this.toView(segment),
      events: events.map((event) => ({
        id: String(event.id),
        eventType: event.eventType,
        eventCode: event.eventCode,
        eventDateTime: event.eventDateTime,
        recordStatus: event.recordStatus,
        recordOrigin: event.recordOrigin,
        wasStoredOnDevice: event.wasStoredOnDevice,
        locationName: event.locationName,
        totalVehicleMiles: event.totalVehicleMiles,
      })),
    };
  }

  /**
   * §7.4 / §23 — attributes the segment to a driver. Appends an attributed copy of every
   * record with `recordOrigin = 1` (never 2) and retires the pool record with an
   * "Inactive — Changed" marker. Writes `UNIDENTIFIED_ASSIGNED` to the audit log.
   */
  async assign(id: string, dto: AssignUnidentifiedDto, actor: ContextUser) {
    const segment = await this.requireSegment(id);
    if (segment.status === 'ASSIGNED') {
      throw new AppException(
        ERROR_CODES.UNIDENTIFIED_ALREADY_ASSIGNED,
        'This segment is already assigned to a driver.',
        409,
        { id, assignedDriverId: segment.assignedDriverId },
      );
    }
    const driver = await this.repo.findDriver(dto.driverId);
    if (!driver) {
      throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404, {
        driverId: dto.driverId,
      });
    }

    const pool = await this.activePoolRecords(segment);
    if (!pool.length) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'This segment has no active unidentified records left to assign.',
        409,
        { id },
      );
    }

    const annotation = dto.annotation ?? `Unidentified driving assigned to ${driver.username}`;
    const timezone = driver.homeTerminalTimezone;

    // 1) Retire the pool records — append-only, so the originals themselves are untouched.
    const markers: AppendRow[] = pool.map((event) => ({
      kind: 'INACTIVE_MARKER',
      eventType: event.eventType,
      eventCode: event.eventCode,
      at: event.eventDateTime,
      recordStatus: RECORD_STATUS.INACTIVE_CHANGED,
      // The pool record stays what it was: automatically recorded, unidentified.
      recordOrigin: RECORD_ORIGIN.UNIDENTIFIED,
      supersedesId: event.id,
      annotation,
    }));

    // 2) The attributed copies. `recordOrigin = 1` — §23: assignment never makes it 2.
    const copies: AppendRow[] = pool.map((event) => ({
      kind: 'NEW_ACTIVE',
      eventType: event.eventType,
      eventCode: event.eventCode,
      at: event.eventDateTime,
      recordStatus: RECORD_STATUS.ACTIVE,
      recordOrigin: RECORD_ORIGIN.ELD_AUTOMATIC,
      supersedesId: event.id,
      annotation,
    }));

    // 3) The driver must not be left driving forever: close the segment with an off-duty
    //    record unless they already have a later record of their own.
    const later = await this.repo.findDriverEventsAfter(driver.id, segment.endAt);
    if (!later.length) {
      copies.push({
        kind: 'RESTORE',
        eventType: 1,
        eventCode: 1,
        at: segment.endAt,
        recordStatus: RECORD_STATUS.ACTIVE,
        recordOrigin: RECORD_ORIGIN.OTHER_USER,
        supersedesId: null,
        annotation,
      });
    }

    await this.repo.runInTransaction(async (tx) => {
      await this.writer.append(
        tx,
        {
          driverId: null,
          sequenceKey: `unidentified:${segment.vehicleId}`,
          timezone,
          vehicleId: segment.vehicleId,
          editedById: actor.id,
          editorType: actor.type === 'driver' ? EditorType.DRIVER : EditorType.USER,
          editReason: annotation,
        },
        markers,
      );
      await this.writer.append(
        tx,
        {
          driverId: driver.id,
          sequenceKey: driver.id,
          timezone,
          vehicleId: segment.vehicleId,
          editedById: actor.id,
          editorType: actor.type === 'driver' ? EditorType.DRIVER : EditorType.USER,
          editReason: annotation,
        },
        copies,
      );
    });

    const updated = await this.repo.updateSegment(id, {
      status: 'ASSIGNED',
      assignedDriverId: driver.id,
      assignedById: actor.id,
      assignedAt: new Date(),
      annotation: annotation.slice(0, 60),
    });

    await this.writeAudit(actor, 'UNIDENTIFIED_ASSIGNED', id, {
      before: { status: segment.status, assignedDriverId: segment.assignedDriverId },
      after: {
        status: 'ASSIGNED',
        assignedDriverId: driver.id,
        recordOrigin: RECORD_ORIGIN.ELD_AUTOMATIC,
        events: pool.length,
      },
      detail: 'Unidentified driving assigned; recordOrigin stays 1 (TZ §23, §7.4).',
    });
    // B-050 / B-059 — the attributed driving changes the driver's RODS: every day the segment
    // touches loses its certification (§395.8(f), re-certification required), the day totals are
    // rebuilt (plus the next day's when it runs past midnight) and `hasUnassigned` drops now that
    // the segment is no longer PENDING. Same hook as an accepted edit (`LogsService`).
    await this.logs.recordLogChange(driver.id, timezone, segment.startAt, segment.endAt);
    await this.enqueueRecalc(driver.id, dayKey(timezone, segment.startAt));
    await this.events.publish('unidentified.assigned', {
      segmentId: id,
      driverId: driver.id,
      durationSec: segment.durationSec,
    });

    return this.toView(updated);
  }

  /**
   * §23 — rejection returns the records to the pool: `recordOrigin = 4`, `driverId = null`.
   * The assigned copies are retired; nothing is ever deleted.
   */
  async reject(id: string, dto: RejectUnidentifiedDto, actor: ContextUser) {
    const segment = await this.requireSegment(id);
    const annotation = dto.reason ?? 'Unidentified driving assignment rejected';

    if (segment.status !== 'ASSIGNED' || !segment.assignedDriverId) {
      // Nothing was ever attributed: the segment simply stays in the pool.
      const updated = await this.repo.updateSegment(id, {
        status: 'REJECTED',
        annotation: annotation.slice(0, 60),
      });
      await this.writeAudit(actor, 'UNIDENTIFIED_REJECTED', id, {
        before: { status: segment.status },
        after: { status: 'REJECTED' },
        detail: 'Unidentified driving rejected; the records stay unidentified (recordOrigin 4).',
      });
      return this.toView(updated);
    }

    const driverId = segment.assignedDriverId;
    const driver = await this.repo.findDriver(driverId);
    const timezone = driver?.homeTerminalTimezone ?? 'UTC';
    const assigned = (await this.repo.findSupersedingEvents(segment.eventIds)).filter(
      (event) => event.driverId === driverId && event.recordStatus === RECORD_STATUS.ACTIVE,
    );

    const markers: AppendRow[] = assigned.map((event) => ({
      kind: 'INACTIVE_MARKER',
      eventType: event.eventType,
      eventCode: event.eventCode,
      at: event.eventDateTime,
      recordStatus: RECORD_STATUS.INACTIVE_CHANGED,
      recordOrigin: RECORD_ORIGIN.ELD_AUTOMATIC,
      supersedesId: event.id,
      annotation,
    }));

    const backToPool: AppendRow[] = assigned.map((event) => ({
      kind: 'NEW_ACTIVE',
      eventType: event.eventType,
      eventCode: event.eventCode,
      at: event.eventDateTime,
      recordStatus: RECORD_STATUS.ACTIVE,
      recordOrigin: RECORD_ORIGIN.UNIDENTIFIED,
      supersedesId: event.id,
      annotation,
    }));

    await this.repo.runInTransaction(async (tx) => {
      await this.writer.append(
        tx,
        {
          driverId,
          sequenceKey: driverId,
          timezone,
          vehicleId: segment.vehicleId,
          editedById: actor.id,
          editorType: actor.type === 'driver' ? EditorType.DRIVER : EditorType.USER,
          editReason: annotation,
        },
        markers,
      );
      await this.writer.append(
        tx,
        {
          driverId: null,
          sequenceKey: `unidentified:${segment.vehicleId}`,
          timezone,
          vehicleId: segment.vehicleId,
          editedById: actor.id,
          editorType: actor.type === 'driver' ? EditorType.DRIVER : EditorType.USER,
          editReason: annotation,
        },
        backToPool,
      );
    });

    const updated = await this.repo.updateSegment(id, {
      status: 'REJECTED',
      assignedDriverId: null,
      annotation: annotation.slice(0, 60),
    });

    await this.writeAudit(actor, 'UNIDENTIFIED_REJECTED', id, {
      before: { status: 'ASSIGNED', assignedDriverId: driverId },
      after: { status: 'REJECTED', assignedDriverId: null, recordOrigin: RECORD_ORIGIN.UNIDENTIFIED },
      detail: 'Assignment rejected; records returned to the unidentified pool (recordOrigin 4, driverId null).',
    });
    // B-050 / B-059 — the driving leaves this driver's log again: void the same span's
    // certification and rebuild its totals.
    await this.logs.recordLogChange(driverId, timezone, segment.startAt, segment.endAt);
    await this.enqueueRecalc(driverId, dayKey(timezone, segment.startAt));
    await this.events.publish('unidentified.rejected', { segmentId: id, driverId });

    return this.toView(updated);
  }

  /** §5.9 — a carrier annotation explaining the segment; the records themselves are untouched. */
  async annotate(id: string, dto: AnnotateUnidentifiedDto, actor: ContextUser) {
    const segment = await this.requireSegment(id);
    const updated = await this.repo.updateSegment(id, {
      annotation: dto.annotation.slice(0, 60),
      ...(segment.status === 'PENDING' ? { status: 'ANNOTATED' as const } : {}),
    });
    await this.writeAudit(actor, 'UNIDENTIFIED_ANNOTATED', id, {
      before: { annotation: segment.annotation },
      after: { annotation: dto.annotation },
      detail: 'Unidentified driving annotated (§5.9).',
    });
    return this.toView(updated);
  }

  /** §7.4 rule 2 — the driver's answer to "was this you?". */
  async confirm(id: string, dto: ConfirmUnidentifiedDto, actor: ContextUser) {
    const segment = await this.requireSegment(id);
    if (dto.accept) {
      // §395.32 — a self-claim is only credible on a unit this driver actually operated.
      // A carrier user assigning through `POST /unidentified/:id/assign` (hosEdit = FULL) is a
      // different, audited decision and keeps its own rules.
      const associated = await this.repo.hasDriverVehicleAssociation(
        actor.id,
        segment.vehicleId,
        segment.endAt,
      );
      if (!associated) {
        await this.writeAudit(actor, 'UNIDENTIFIED_CONFIRM_DENIED', id, {
          after: { driverId: actor.id, vehicleId: segment.vehicleId },
          detail: 'Self-claim refused: the driver has no assignment or login session on this unit (§395.32).',
        });
        throw new AppException(
          ERROR_CODES.FORBIDDEN,
          'You can only claim unidentified driving recorded on a vehicle you operated.',
          403,
          { segmentId: id },
        );
      }
      return this.assign(id, { driverId: actor.id, annotation: dto.annotation }, actor);
    }
    if (segment.assignedDriverId === actor.id) {
      return this.reject(id, { reason: dto.annotation }, actor);
    }
    await this.writeAudit(actor, 'UNIDENTIFIED_CONFIRM_DECLINED', id, {
      after: { driverId: actor.id, accepted: false },
      detail: 'Driver declined ownership; the segment stays unidentified (§7.4 rule 2).',
    });
    return this.toView(segment);
  }

  // ---------------------------------------------------------------- helpers

  /**
   * The records that currently represent this segment in the pool: the original event, or the
   * newest active `recordOrigin = 4` record appended on top of it after a rejection.
   */
  private async activePoolRecords(segment: UnidentifiedSegment): Promise<EldEvent[]> {
    const originals = await this.repo.findEventsByIds(segment.eventIds);
    const leaves = new Map<string, EldEvent>();
    for (const event of originals) leaves.set(String(event.id), event);

    let frontier = originals.map((event) => event.id);
    for (let depth = 0; depth < 5 && frontier.length; depth += 1) {
      const children = await this.repo.findSupersedingEvents(frontier);
      if (!children.length) break;
      for (const child of children) {
        const parentKey = String(child.supersedesId);
        const rootKey = findRoot(leaves, parentKey) ?? parentKey;
        if (child.recordStatus === RECORD_STATUS.ACTIVE && child.driverId === null) {
          leaves.set(rootKey, child);
        } else if (child.recordStatus === RECORD_STATUS.INACTIVE_CHANGED) {
          const current = leaves.get(rootKey);
          if (current && String(current.id) === parentKey) leaves.delete(rootKey);
        }
      }
      frontier = children.map((child) => child.id);
    }
    return [...leaves.values()].sort(
      (a, b) => a.eventDateTime.getTime() - b.eventDateTime.getTime(),
    );
  }

  private async requireSegment(id: string): Promise<UnidentifiedSegment> {
    const segment = await this.repo.findSegment(id);
    if (!segment) {
      throw new AppException(ERROR_CODES.NOT_FOUND, 'Unidentified segment not found.', 404, { id });
    }
    return segment;
  }

  private async enqueueRecalc(driverId: string, fromDate: string): Promise<void> {
    try {
      await this.hosRecalcQueue.add('hos.recalc', { driverId, fromDate });
    } catch (err) {
      this.logger.error({ err, driverId }, 'Failed to enqueue hos.recalc after an assignment');
    }
  }

  private async writeAudit(
    actor: ContextUser,
    action: string,
    objectId: string,
    data: { before?: unknown; after?: unknown; detail?: string },
  ): Promise<void> {
    const ctx = RequestContext.get();
    try {
      await this.audit.insert({
        actorId: actor.id,
        actorType: actor.type === 'driver' ? EditorType.DRIVER : EditorType.USER,
        action,
        objectType: 'UnidentifiedSegment',
        objectId,
        before: data.before ?? undefined,
        after: data.after ?? undefined,
        detail: data.detail,
        ip: ctx?.ip,
        userAgent: ctx?.userAgent,
      });
    } catch (err) {
      this.logger.error({ err, action, objectId }, 'Failed to write the unidentified audit entry');
    }
  }

  private toView(segment: UnidentifiedSegment) {
    return {
      id: segment.id,
      vehicleId: segment.vehicleId,
      startAt: segment.startAt,
      endAt: segment.endAt,
      durationSec: segment.durationSec,
      distanceMi: segment.distanceMi,
      status: segment.status,
      assignedDriverId: segment.assignedDriverId,
      assignedById: segment.assignedById,
      assignedAt: segment.assignedAt,
      annotation: segment.annotation,
      /** §23 — true when these records came out of the PT30's memory. Never dropped. */
      fromStoredEvents: segment.fromStoredEvents,
      eventIds: segment.eventIds.map((id) => String(id)),
    };
  }
}

/** Which original id a superseding record ultimately belongs to. */
function findRoot(leaves: Map<string, EldEvent>, parentKey: string): string | null {
  for (const [root, event] of leaves) {
    if (String(event.id) === parentKey) return root;
  }
  return null;
}
