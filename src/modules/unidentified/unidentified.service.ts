import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { EditorType, type EldEvent, type Prisma, type UnidentifiedSegment } from '@prisma/client';
import { Queue } from 'bullmq';
import { AppException } from '../../common/errors/app.exception';
import { locationTextOf } from '../../common/geo-location/location-description';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { RequestContext } from '../../core/context/request-context';
import { EventBusService } from '../../core/events/event-bus.service';
import { QUEUES } from '../../core/queue/queue.constants';
import { AuditRepository } from '../audit/audit.repository';
import { addDays, dayKey, dayStart } from '../hos/engine/timezone';
import { RECORD_ORIGIN, RECORD_STATUS } from '../ingest/event-codes';
import { RODS_HEADER_LOOKBACK_DAYS } from '../logs/daily-log-header';
import type { AppendRow } from '../logs/edit-plan';
import { LogsService } from '../logs/logs.service';
import { DUTY_CODE_BY_STATUS, type RodsEvent } from '../logs/rods';
import { RodsEventWriter } from '../logs/rods-event-writer';
import { planAssignmentAgainstDriverLog, type AssignmentConflict } from './assignment-plan';
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
 *   1. An attributed record is NEVER `recordOrigin = 2` — attribution does not make a record
 *      driver-entered (§23, §7.4). A carrier assignment keeps `1` (automatically recorded by the
 *      ELD, TZ §23). MB-3 / B-157 / D-137 — when the DRIVER assumes the records (accepts a confirmation
 *      request or self-claims), Appendix A 4.4.4.2.4(e) requires `4` ("assumed from unidentified
 *      driver profile"); Appendix A outranks tz.md. Rejecting an assignment puts the records back
 *      in the pool as `recordOrigin = 4`, `driverId = null`.
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
    @InjectQueue(QUEUES.ALERT) private readonly alertQueue: Queue,
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
   * §7.4 / §395.32 — a carrier assignment is a PROPOSAL (CODE-029): nothing is attributed, the
   * segment goes to `PENDING_CONFIRMATION` and the driver accepts or declines in the app. Only the
   * driver's own answer (`confirm`, or a self-claim with `driverAssumed`) attributes the records:
   * an appended copy of every record (never origin 2) and an "Inactive — Changed" marker on the
   * pool record, audited as `UNIDENTIFIED_ASSIGNED`.
   */
  async assign(id: string, dto: AssignUnidentifiedDto, actor: ContextUser, opts: { driverAssumed?: boolean } = {}) {
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

    if (!opts.driverAssumed) {
      // CODE-029 — the carrier never attributes directly; the driver confirms in the app.
      // CODE-007 — refuse up front what the driver could never confirm (re-checked on confirm).
      await this.planAgainstDriverLog(segment, driver);
      return this.requestConfirmation(segment, driver, dto.annotation ?? null, actor);
    }
    return this.attribute(segment, pool, driver, dto.annotation ?? null, actor, {
      assignedById: actor.id,
      confirmedByDriver: true,
    });
  }

  /**
   * B-83 — the carrier picked a driver but asked for their confirmation first. NOTHING is
   * attributed: the records stay in the unidentified pool (origin 4, still reported as
   * unidentified in eRODS and still flagging `hasUnassigned`) until the driver confirms in the
   * app. The segment waits in `PENDING_CONFIRMATION` with the asked driver and the requester.
   */
  private async requestConfirmation(
    segment: UnidentifiedSegment,
    driver: { id: string; username: string },
    annotation: string | null,
    actor: ContextUser,
  ) {
    const requestedAt = new Date();
    const updated = await this.repo.updateSegment(segment.id, {
      status: 'PENDING_CONFIRMATION',
      assignedDriverId: driver.id,
      assignedById: actor.id,
      assignedAt: null,
      confirmationRequestedAt: requestedAt,
      ...(annotation ? { annotation: annotation.slice(0, 60) } : {}),
    });
    await this.writeAudit(actor, 'UNIDENTIFIED_CONFIRMATION_REQUESTED', segment.id, {
      before: { status: segment.status, assignedDriverId: segment.assignedDriverId },
      after: {
        status: 'PENDING_CONFIRMATION',
        requestedDriverId: driver.id,
        confirmationRequestedAt: requestedAt.toISOString(),
      },
      detail: 'Carrier asked the driver to confirm this unidentified driving; nothing is attributed until they do (§395.32).',
    });
    const payload = {
      segmentId: segment.id,
      driverId: driver.id,
      vehicleId: segment.vehicleId,
      startAt: segment.startAt.toISOString(),
      endAt: segment.endAt.toISOString(),
      durationSec: segment.durationSec,
      requestedById: actor.id,
    };
    await this.events.publish('unidentified.confirmation_requested', payload);
    // The driver-app prompt (S-21 "Was this you?"): socket now, IN_APP + FCM through the alert
    // pipeline (kind UNIDENTIFIED, objectRef = the segment).
    await this.events.publish('realtime.push', {
      room: `driver:${driver.id}`,
      event: 'unidentified.confirmation_requested',
      payload,
    });
    // MB-7 — title/message for the in-app row + FCM (identifiers only in `data`).
    await this.raiseAlert('alert.unidentified_confirmation_requested', {
      ...payload,
      title: 'Was this you?',
      message: 'Your carrier asked you to confirm unidentified driving time.',
    });
    return this.toView(updated);
  }

  /**
   * B-83 — the driver-app list of segments a carrier asked THIS driver to confirm. MB-11 — each
   * item also carries what the "Was this you?" card shows: start/end location (Appendix A 7.29
   * text), the unit number and the start/end odometer, all read from the segment's own records.
   */
  async listConfirmationRequests(actor: ContextUser) {
    const page = await this.repo.listSegments(
      { status: 'PENDING_CONFIRMATION', assignedDriverId: actor.id },
      1,
      200,
    );
    const segments = page.items;
    const [events, units] = await Promise.all([
      this.repo.findEventsByIds(segments.flatMap((segment) => segment.eventIds)),
      this.repo.findVehicleUnitNumbers([...new Set(segments.map((segment) => segment.vehicleId))]),
    ]);
    return {
      items: segments.map((segment) => ({
        ...this.toView(segment),
        ...confirmationCardOf(segment, events, units),
      })),
    };
  }

  /**
   * Attributes the pool records to `driver` (the actual §7.4 assignment). `assignedById` is the
   * carrier user who made the decision — the requester when a driver confirms a B-83 request.
   */
  private async attribute(
    segment: UnidentifiedSegment,
    pool: EldEvent[],
    driver: { id: string; username: string; homeTerminalTimezone: string },
    requestedAnnotation: string | null,
    actor: ContextUser,
    opts: { assignedById: string; confirmedByDriver: boolean },
  ) {
    const id = segment.id;
    const annotation = requestedAnnotation ?? `Unidentified driving assigned to ${driver.username}`;
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

    // 2) The attributed copies — never origin 2 (§23). MB-3: a driver's own assumption is origin 4
    //    (Appendix A 4.4.4.2.4(e)); a carrier assignment stays origin 1 (TZ §23).
    const copyOrigin = opts.confirmedByDriver ? RECORD_ORIGIN.UNIDENTIFIED : RECORD_ORIGIN.ELD_AUTOMATIC;
    const copies: AppendRow[] = pool.map((event) => ({
      kind: 'NEW_ACTIVE',
      eventType: event.eventType,
      eventCode: event.eventCode,
      at: event.eventDateTime,
      recordStatus: RECORD_STATUS.ACTIVE,
      recordOrigin: copyOrigin,
      supersedesId: event.id,
      annotation,
    }));

    // 3) CODE-007 — the segment must end where it ends: at `endAt` the driver goes back to the
    //    status their own log had in force there (OFF without any record). Before, the segment's
    //    last status ran on until the driver's next own record (phantom on-duty / driving time).
    //    A segment that overlaps the driver's own records is refused before anything is written.
    const restoreStatus = await this.planAgainstDriverLog(segment, driver);
    if (restoreStatus) {
      copies.push({
        kind: 'RESTORE',
        eventType: 1,
        eventCode: DUTY_CODE_BY_STATUS[restoreStatus],
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
      assignedById: opts.assignedById,
      assignedAt: new Date(),
      annotation: annotation.slice(0, 60),
    });

    await this.writeAudit(actor, 'UNIDENTIFIED_ASSIGNED', id, {
      before: { status: segment.status, assignedDriverId: segment.assignedDriverId },
      after: {
        status: 'ASSIGNED',
        assignedDriverId: driver.id,
        assignedById: opts.assignedById,
        confirmedByDriver: opts.confirmedByDriver,
        recordOrigin: copyOrigin,
        events: pool.length,
      },
      detail: opts.confirmedByDriver
        ? 'Unidentified driving assumed by the driver; recordOrigin 4 (Appendix A 4.4.4.2.4(e)).'
        : 'Unidentified driving assigned; recordOrigin stays 1 (TZ §23, §7.4).',
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
      // Nothing was ever attributed: the segment simply stays in the pool. A B-83 request that
      // was still waiting for the driver is withdrawn with it.
      const updated = await this.repo.updateSegment(id, {
        status: 'REJECTED',
        annotation: annotation.slice(0, 60),
        ...(segment.status === 'PENDING_CONFIRMATION'
          ? { assignedDriverId: null, assignedById: null, confirmationRequestedAt: null }
          : {}),
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
      // The retired copy keeps what it was: 1 (carrier assignment) or 4 (driver assumption, MB-3).
      recordOrigin: event.recordOrigin,
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
    if (segment.status === 'PENDING_CONFIRMATION') {
      return this.answerConfirmationRequest(segment, dto, actor);
    }
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
      return this.assign(id, { driverId: actor.id, annotation: dto.annotation }, actor, { driverAssumed: true });
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

  /**
   * B-83 — the asked driver answers a carrier's confirmation request. Accept: the records are
   * attributed now (origin 4 — the driver assumes them, Appendix A 4.4.4.2.4(e), MB-3; never 2),
   * `assignedById` stays the carrier user who decided.
   * Decline: nothing was ever attributed, the segment goes back to `PENDING` for the carrier.
   * Only the driver who was asked may answer.
   */
  private async answerConfirmationRequest(segment: UnidentifiedSegment, dto: ConfirmUnidentifiedDto, actor: ContextUser) {
    if (segment.assignedDriverId !== actor.id) {
      throw new AppException(
        ERROR_CODES.FORBIDDEN,
        'This unidentified driving is awaiting confirmation from another driver.',
        403,
        { segmentId: segment.id },
      );
    }
    if (dto.accept) {
      const driver = await this.repo.findDriver(actor.id);
      if (!driver) {
        throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404, { driverId: actor.id });
      }
      const pool = await this.activePoolRecords(segment);
      if (!pool.length) {
        throw new AppException(
          ERROR_CODES.CONFLICT,
          'This segment has no active unidentified records left to assign.',
          409,
          { id: segment.id },
        );
      }
      return this.attribute(segment, pool, driver, dto.annotation ?? segment.annotation ?? null, actor, {
        assignedById: segment.assignedById ?? actor.id,
        confirmedByDriver: true,
      });
    }

    const updated = await this.repo.updateSegment(segment.id, {
      status: 'PENDING',
      assignedDriverId: null,
      assignedById: null,
      confirmationRequestedAt: null,
    });
    await this.writeAudit(actor, 'UNIDENTIFIED_CONFIRMATION_DECLINED', segment.id, {
      before: {
        status: 'PENDING_CONFIRMATION',
        requestedDriverId: actor.id,
        requestedById: segment.assignedById,
        confirmationRequestedAt: segment.confirmationRequestedAt?.toISOString() ?? null,
      },
      after: { status: 'PENDING', assignedDriverId: null, annotation: dto.annotation ?? null },
      detail: 'Driver declined the carrier assignment; the records stay unidentified (recordOrigin 4).',
    });
    const payload = { segmentId: segment.id, driverId: actor.id, requestedById: segment.assignedById };
    await this.events.publish('unidentified.confirmation_declined', payload);
    await this.raiseAlert('alert.unidentified_confirmation_declined', payload);
    return this.toView(updated);
  }

  // ---------------------------------------------------------------- helpers

  /**
   * CODE-007 — reads the driver's own timeline around the segment (same lookback as the RODS
   * header) and returns the status the RESTORE record re-states at `endAt` (null: none needed).
   * Throws 409 `UNIDENTIFIED_OVERLAPS_DRIVER_LOG` when the segment overlaps the driver's own log.
   */
  private async planAgainstDriverLog(
    segment: UnidentifiedSegment,
    driver: { id: string; homeTerminalTimezone: string },
  ) {
    const timezone = driver.homeTerminalTimezone;
    const from = dayStart(timezone, addDays(dayKey(timezone, segment.startAt), -RODS_HEADER_LOOKBACK_DAYS));
    const own = (await this.repo.findDriverEvents(driver.id, from, segment.endAt)) as unknown as RodsEvent[];
    const plan = planAssignmentAgainstDriverLog(own, segment);
    if (plan.conflict) {
      throw new AppException(ERROR_CODES.UNIDENTIFIED_OVERLAPS_DRIVER_LOG, overlapMessage(plan.conflict), 409, {
        segmentId: segment.id,
        driverId: driver.id,
        reason: plan.conflict.reason,
        conflictingAt: plan.conflict.conflictingAt.map((at) => at.toISOString()),
      });
    }
    return plan.restoreStatus;
  }

  private async raiseAlert(name: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.alertQueue.add(name, payload);
    } catch (err) {
      this.logger.error({ err, alert: name }, 'Failed to enqueue alert');
    }
  }

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
      /** B-83 — set while the segment waits for the asked driver (`PENDING_CONFIRMATION`). */
      confirmationRequestedAt: segment.confirmationRequestedAt,
      /** §23 — true when these records came out of the PT30's memory. Never dropped. */
      fromStoredEvents: segment.fromStoredEvents,
      eventIds: segment.eventIds.map((id) => String(id)),
    };
  }
}

/**
 * MB-11 — the "Was this you?" card fields of one segment. The stored segment location wins when
 * set; otherwise the first / last record's location text (stored name, else the offline Appendix
 * A 7.29 geo-location of the coarsened position). Odometer: first / last record that has one.
 */
export function confirmationCardOf(
  segment: Pick<UnidentifiedSegment, 'vehicleId' | 'eventIds' | 'startLocation' | 'endLocation'>,
  events: EldEvent[],
  units: Map<string, string>,
) {
  const ids = new Set(segment.eventIds.map((id) => String(id)));
  const own = events
    .filter((event) => ids.has(String(event.id)))
    .sort((a, b) => a.eventDateTime.getTime() - b.eventDateTime.getTime());
  const withMiles = own.filter((event) => typeof event.totalVehicleMiles === 'number');
  return {
    startLocation: segment.startLocation ?? locationTextOf(own[0]),
    endLocation: segment.endLocation ?? locationTextOf(own[own.length - 1]),
    unitNumber: units.get(segment.vehicleId) ?? null,
    startOdometerMi: withMiles.length ? withMiles[0].totalVehicleMiles : null,
    endOdometerMi: withMiles.length ? withMiles[withMiles.length - 1].totalVehicleMiles : null,
  };
}

/** CODE-007 — the refusal sentence the panel shows as is (a dispatcher must be able to act on it). */
function overlapMessage(conflict: AssignmentConflict): string {
  switch (conflict.reason) {
    case 'DRIVING_AT_START':
      return "This driver was already driving when this unidentified driving started. Correct the driver's log first or assign it to another driver.";
    case 'SPECIAL_AT_START':
      return "This driver was on personal conveyance or yard move when this unidentified driving started. Correct the driver's log first or assign it to another driver.";
    default:
      return "This driver's own log already has duty-status records during this unidentified driving. Correct the driver's log first or assign it to another driver.";
  }
}

/** Which original id a superseding record ultimately belongs to. */
function findRoot(leaves: Map<string, EldEvent>, parentKey: string): string | null {
  for (const [root, event] of leaves) {
    if (String(event.id) === parentKey) return root;
  }
  return null;
}
