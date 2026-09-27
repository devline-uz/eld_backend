import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { EditorType } from '@prisma/client';
import { Queue } from 'bullmq';
import type { EldEvent } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { RequestContext } from '../../core/context/request-context';
import { EventBusService } from '../../core/events/event-bus.service';
import { QUEUES } from '../../core/queue/queue.constants';
import { AuditRepository } from '../audit/audit.repository';
import { addDays, dayEnd, dayKey, dayStart } from '../hos/engine/timezone';
import type { DutyStatus } from '../hos/hos.types';
import {
  CERTIFICATION_EVENT_TYPE,
  UNCERTIFIED_LOGS_ALERT_DAYS,
  certificationEventCode,
  uncertifiedAlertDue,
} from './certification';
import {
  AppendRow,
  formatProposalMeta,
  parseProposalMeta,
  planAcceptEdit,
  planDriverSelfEdit,
  planEditRequest,
  planProposedEvent,
  planRejectEdit,
  type SpecialCategory,
} from './edit-plan';
import {
  IMMUTABILITY_DETAIL,
  checkDriverSelfEdit,
  checkEditProposal,
  type DrivingImmutabilityReason,
} from './edit-rules';
import {
  CertifyDto,
  CreateEditRequestDto,
  CreateLogEntryDto,
  EditRequestListQueryDto,
  ProposeEventDto,
  ResolveEditRequestDto,
} from './dto/logs.dto';
import { LogsRepository } from './logs.repository';
import { RodsEventWriter } from './rods-event-writer';
import { affectedHeaderRange, buildDailyLogHeaders, RODS_HEADER_LOOKBACK_DAYS } from './daily-log-header';
import { activeRecords, drivingIntervals, statusInEffectAt, type RodsEvent } from './rods';

/** History pulled in around an edited instant so the edit rules see the neighbouring records. */
const LOOKBACK_DAYS = 2;
/** A range query may never walk a year (§19 — bounded work per request). */
const MAX_RANGE_DAYS = 62;

export interface EditRequestView {
  id: string;
  driverId: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  /** B-72 — `INSERT` is a proposed new record (no original), `EDIT` replaces `originalEventId`. */
  kind: 'EDIT' | 'INSERT';
  originalEventId: string | null;
  proposedStatus: DutyStatus | null;
  /** B-39 — §395.1(e) category the driver is asked to accept (PC/YM), `NONE` otherwise. */
  proposedSpecial: SpecialCategory;
  proposedStart: Date;
  proposedEnd: Date | null;
  locationName: string | null;
  annotation: string | null;
  requestedById: string | null;
  requestedAt: Date;
  resolvedAt: Date | null;
}

const DUTY_STATUS_BY_CODE: Record<number, DutyStatus> = { 1: 'OFF', 2: 'SB', 3: 'D', 4: 'ON' };

/**
 * TZ §9 — RODS: the daily log, the §395.30 edit flow, the driver's own corrections and
 * certification.
 *
 * Three rules from 49 CFR §395 govern everything here and outrank any other document:
 *   §395.30(c)(2) driving time can never be shortened, deleted or restatused;
 *   §395.30(c)(1) a carrier edit is a PROPOSAL — it takes effect only when the driver accepts;
 *   §395.22(i)   any change to a certified log requires re-certification.
 */
@Injectable()
export class LogsService {
  private readonly logger = new Logger(LogsService.name);

  constructor(
    private readonly repo: LogsRepository,
    private readonly writer: RodsEventWriter,
    private readonly audit: AuditRepository,
    private readonly events: EventBusService,
    @InjectQueue(QUEUES.HOS_RECALC) private readonly hosRecalcQueue: Queue,
    @InjectQueue(QUEUES.ALERT) private readonly alertQueue: Queue,
  ) {}

  // =========================================================================
  // GET /logs/:driverId — RODS day generation (§9, §23 "split by home terminal")
  // =========================================================================

  async getDay(driverId: string, date: string | undefined, now: Date = new Date()) {
    const driver = await this.requireDriver(driverId);
    const key = date ?? dayKey(driver.homeTerminalTimezone, now);
    const days = await this.buildDays(driverId, key, key, now);
    return days[0];
  }

  async getRange(driverId: string, from: string, to: string, now: Date = new Date()) {
    await this.requireDriver(driverId);
    const days = await this.buildDays(driverId, from, to, now);
    return { driverId, from, to, days: days.map((day) => day.summary) };
  }

  /**
   * TZ §13.5 — the last 8 days, FULL (graph + events + certification state), for the app to
   * cache at bootstrap and show read-only during an offline DOT inspection. Reuses `buildDays`
   * so the offline packet and the online `/logs/:driverId/range` view can never disagree.
   */
  async getInspectionPacket(driverId: string, now: Date = new Date()) {
    const driver = await this.requireDriver(driverId);
    const timezone = driver.homeTerminalTimezone;
    const todayKey = dayKey(timezone, now);
    const fromKey = addDays(todayKey, -7);
    const days = await this.buildDays(driverId, fromKey, todayKey, now);
    return { driverId, timezone, generatedAt: now, days };
  }

  /** The raw §395 record list of one RODS day, INCLUDING superseded and proposed records. */
  async getEvents(driverId: string, date: string | undefined, now: Date = new Date()) {
    const driver = await this.requireDriver(driverId);
    const timezone = driver.homeTerminalTimezone;
    const key = date ?? dayKey(timezone, now);
    const events = await this.repo.findEvents(
      driverId,
      dayStart(timezone, key),
      dayEnd(timezone, key),
    );
    return {
      driverId,
      date: key,
      timezone,
      events: events.map((event) => this.toEventView(event)),
    };
  }

  /**
   * Rebuilds every RODS day in the range and persists the `DailyLog` header. Certification
   * state is never written here — only `certify()` and `invalidate` touch it (§9.2).
   */
  private async buildDays(driverId: string, fromKey: string, toKey: string, now: Date) {
    const driver = await this.requireDriver(driverId);
    const timezone = driver.homeTerminalTimezone;
    const keys = dayKeyRange(fromKey, toKey);

    // B-059 — the same lookback as `hos.recalc`, so a status carried for several days is counted
    // identically by the log view and by the recalculation that rebuilds the same header.
    const windowStart = dayStart(timezone, addDays(fromKey, -RODS_HEADER_LOOKBACK_DAYS));
    const windowEnd = dayEnd(timezone, toKey);
    const events = await this.repo.findEvents(driverId, windowStart, windowEnd);
    const vehicleIds = await this.repo.findVehicleIdsForDriver(driverId, windowStart, windowEnd);
    const segments = await this.repo.findUnidentifiedSegments(vehicleIds, windowStart, windowEnd);
    const violations = await this.repo.findViolations(
      driverId,
      utcDate(fromKey),
      utcDate(toKey),
    );
    const headers = await this.repo.findDailyLogs(driverId, utcDate(fromKey), utcDate(toKey));

    const built = buildDailyLogHeaders({
      events,
      timezone,
      fromKey,
      toKey: keys[keys.length - 1],
      now,
      segments,
      previousHasEdits: new Map(headers.map((h) => [dayKey('UTC', h.logDate), h.hasEdits])),
      maxDays: MAX_RANGE_DAYS,
    });

    const out = [];
    for (const { day, header: totals } of built) {
      const key = totals.logDate;
      const dayViolations = violations.filter((row) => dayKey('UTC', row.logDate) === key);
      const { logDate: _logDate, ...headerTotals } = totals;
      const header = await this.repo.upsertDailyLog({ driverId, logDate: utcDate(key), ...headerTotals });

      const dayEvents = events.filter(
        (event) =>
          event.eventDateTime.getTime() >= day.startAt.getTime() &&
          event.eventDateTime.getTime() < day.endAt.getTime(),
      );

      out.push({
        driverId,
        date: key,
        timezone,
        summary: {
          date: key,
          timezone,
          offDutySec: day.offDutySec,
          sleeperSec: day.sleeperSec,
          drivingSec: day.drivingSec,
          onDutySec: day.onDutySec,
          totalDistanceMi: day.totalDistanceMi,
          dayLengthSec: day.dayLengthSec,
          certified: header.certified,
          certifiedAt: header.certifiedAt,
          certificationCount: header.certificationCount,
          hasViolation: header.hasViolation,
          violationCount: header.violationCount,
          hasUnassigned: header.hasUnassigned,
          hasEdits: header.hasEdits,
        },
        graph: day.segments,
        events: dayEvents.map((event) => this.toEventView(event)),
        violations: dayViolations,
        certification: {
          certified: header.certified,
          certifiedAt: header.certifiedAt,
          certifiedById: header.certifiedById,
          certifierType: header.certifierType,
          certificationCount: header.certificationCount,
          signatureUrl: header.signatureUrl,
          /** §9.2 — a log that changed after certification must be certified again. */
          recertificationRequired: header.hasEdits && !header.certified,
        },
      });
    }
    return out;
  }

  // =========================================================================
  // §9.1 — the carrier edit request flow (a PROPOSAL, never an applied change)
  // =========================================================================

  async createEditRequest(driverId: string, dto: CreateEditRequestDto, actor: ContextUser) {
    const driver = await this.requireDriver(driverId);
    const timezone = driver.homeTerminalTimezone;
    const original = await this.repo.findEventById(BigInt(dto.originalEventId));
    if (!original || original.driverId !== driverId) {
      throw new AppException(ERROR_CODES.NOT_FOUND, 'Original record not found for this driver.', 404);
    }

    const now = new Date();
    const context = await this.loadEditContext(driverId, timezone, original.eventDateTime, now);
    const target = {
      id: original.id,
      eventType: original.eventType,
      eventCode: original.eventCode,
      eventDateTime: original.eventDateTime,
      intervalEndAt: this.intervalEndOf(context.events, original, now),
    };

    this.assertDrivingImmutable(
      checkEditProposal(
        target,
        {
          proposedStatus: dto.proposedStatus,
          proposedStart: dto.proposedStart,
          proposedEnd: dto.proposedEnd ?? null,
        },
        context.driving,
      ),
    );

    const special: SpecialCategory = dto.proposedSpecial ?? 'NONE';
    const rows = planEditRequest(target, {
      status: dto.proposedStatus,
      startAt: dto.proposedStart,
      endAt: dto.proposedEnd ?? null,
      annotation: dto.reason,
    });

    const ids = await this.repo.runInTransaction((tx) =>
      this.writer.append(
        tx,
        {
          driverId,
          sequenceKey: driverId,
          timezone,
          vehicleId: original.vehicleId,
          deviceId: original.deviceId,
          editedById: actor.id,
          editorType: EditorType.USER,
          editReason: dto.reason,
          location: dto.location ?? null,
          // §23 — a PC position is coarsened to 10 miles BEFORE it is ever written.
          personalConveyance: special === 'PC',
          totalVehicleMiles: dto.odometerMi ?? null,
          totalEngineHours: dto.engineHours ?? null,
          comment: formatProposalMeta({ proposedEnd: dto.proposedEnd ?? null, special }),
        },
        rows,
      ),
    );

    const requestId = firstId(ids, rows);
    const notifyDriver = dto.notifyDriver ?? true;
    await this.writeAudit(actor, 'LOG_EDIT_REQUESTED', 'EldEvent', String(requestId), {
      after: {
        driverId,
        originalEventId: dto.originalEventId,
        proposedStatus: dto.proposedStatus,
        proposedSpecial: special,
        proposedStart: dto.proposedStart.toISOString(),
        proposedEnd: dto.proposedEnd?.toISOString() ?? null,
        location: dto.location ?? null,
        reason: dto.reason,
        notifyDriver,
      },
      detail: 'Carrier edit proposal (49 CFR §395.30) — inert until the driver accepts.',
    });

    await this.notifyProposal(driverId, String(requestId), {
      proposedStatus: dto.proposedStatus,
      proposedSpecial: special,
      proposedStart: dto.proposedStart,
      notifyDriver,
    });

    return {
      id: String(requestId),
      status: 'PENDING' as const,
      driverId,
      originalEventId: dto.originalEventId,
      proposedStatus: dto.proposedStatus,
      proposedSpecial: special,
      proposedStart: dto.proposedStart,
      proposedEnd: dto.proposedEnd ?? null,
      location: dto.location ?? null,
      reason: dto.reason,
      notifyDriver,
      recordStatus: 3,
      /** §395.30 — spelled out for every client: this has NOT been applied. */
      applied: false,
    };
  }

  /**
   * B-72 — `POST /logs/:driverId/events`: the carrier proposes a NEW record, typically on a RODS
   * day that has no duty record yet (an edit request needs an original to point at). §395.30
   * governs it exactly like an edit: stored with `recordStatus = 3` (inert — `activeRecords`
   * ignores it, so it counts toward nothing), audited, pushed to the driver, and applied only
   * when the driver accepts through the same `edit-requests/:id/accept` route. It may never
   * overwrite recorded driving time (§395.30(c)(2)).
   */
  async proposeEvent(driverId: string, dto: ProposeEventDto, actor: ContextUser) {
    const driver = await this.requireDriver(driverId);
    const timezone = driver.homeTerminalTimezone;
    const now = new Date();
    if (dto.eventDateTime.getTime() > now.getTime()) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'A record cannot be proposed in the future.', 422, {
        eventDateTime: dto.eventDateTime.toISOString(),
      });
    }
    const context = await this.loadEditContext(driverId, timezone, dto.eventDateTime, now);
    this.assertDrivingImmutable(
      checkEditProposal(
        this.insertTarget(context.events, dto.eventDateTime, now),
        { proposedStatus: dto.status, proposedStart: dto.eventDateTime, proposedEnd: dto.endDateTime ?? null },
        context.driving,
      ),
    );

    const special: SpecialCategory = dto.proposedSpecial ?? 'NONE';
    const rows = planProposedEvent({
      status: dto.status,
      startAt: dto.eventDateTime,
      endAt: dto.endDateTime ?? null,
      annotation: dto.annotation,
    });

    const ids = await this.repo.runInTransaction((tx) =>
      this.writer.append(
        tx,
        {
          driverId,
          sequenceKey: driverId,
          timezone,
          vehicleId: driver.assignedVehicleId,
          editedById: actor.id,
          editorType: EditorType.USER,
          editReason: dto.annotation,
          location: dto.location ?? null,
          personalConveyance: special === 'PC',
          totalVehicleMiles: dto.odometerMi ?? null,
          totalEngineHours: dto.engineHours ?? null,
          comment: formatProposalMeta({ proposedEnd: dto.endDateTime ?? null, special }),
        },
        rows,
      ),
    );

    const requestId = firstId(ids, rows);
    const notifyDriver = dto.notifyDriver ?? true;
    await this.writeAudit(actor, 'LOG_EVENT_PROPOSED', 'EldEvent', String(requestId), {
      after: {
        driverId,
        status: dto.status,
        proposedSpecial: special,
        eventDateTime: dto.eventDateTime.toISOString(),
        endDateTime: dto.endDateTime?.toISOString() ?? null,
        location: dto.location ?? null,
        odometerMi: dto.odometerMi ?? null,
        engineHours: dto.engineHours ?? null,
        annotation: dto.annotation,
        recordStatus: 3,
        notifyDriver,
      },
      detail: 'Carrier proposed a new record (49 CFR §395.30) — inert until the driver accepts.',
    });
    await this.notifyProposal(driverId, String(requestId), {
      proposedStatus: dto.status,
      proposedSpecial: special,
      proposedStart: dto.eventDateTime,
      notifyDriver,
    });

    return {
      id: String(requestId),
      driverId,
      status: 'PENDING' as const,
      kind: 'INSERT' as const,
      proposedStatus: dto.status,
      proposedSpecial: special,
      eventDateTime: dto.eventDateTime,
      endDateTime: dto.endDateTime ?? null,
      annotation: dto.annotation,
      notifyDriver,
      recordStatus: 3 as const,
      applied: false as const,
    };
  }

  async listEditRequests(driverId: string, query: EditRequestListQueryDto) {
    const driver = await this.requireDriver(driverId);
    const timezone = driver.homeTerminalTimezone;
    const from = query.from ? dayStart(timezone, query.from) : undefined;
    const to = query.to ? dayEnd(timezone, query.to) : undefined;
    const requests = await this.repo.findEditRequests(driverId, from, to);
    const markers = await this.repo.findSupersedingEvents(requests.map((row) => row.id));
    const views = requests.map((request) => this.toEditRequestView(request, markers));
    const filtered = query.status === 'ALL' ? views : views.filter((view) => view.status === query.status);
    return { driverId, items: filtered };
  }

  /** §9.1 step 3 — the driver accepts: new record active (1), old record inactive (2). */
  async acceptEditRequest(requestId: string, actor: ContextUser, dto: ResolveEditRequestDto) {
    const { request, original, driver } = await this.loadPendingRequest(requestId, actor);
    const timezone = driver.homeTerminalTimezone;
    const now = new Date();
    const anchor = original ? original.eventDateTime : request.eventDateTime;
    const context = await this.loadEditContext(driver.id, timezone, anchor, now);

    const proposedStatus = DUTY_STATUS_BY_CODE[request.eventCode];
    const meta = parseProposalMeta(request.comment);
    const proposedEnd = meta.proposedEnd;
    const target = original
      ? {
          id: original.id,
          eventType: original.eventType,
          eventCode: original.eventCode,
          eventDateTime: original.eventDateTime,
          intervalEndAt: this.intervalEndOf(context.events, original, now),
        }
      : null;

    // Re-checked at apply time: the timeline may have changed since the proposal was made.
    this.assertDrivingImmutable(
      checkEditProposal(
        target ?? this.insertTarget(context.events, request.eventDateTime, now),
        { proposedStatus, proposedStart: request.eventDateTime, proposedEnd },
        context.driving,
      ),
    );

    const rows = planAcceptEdit(
      {
        id: request.id,
        eventType: request.eventType,
        eventCode: request.eventCode,
        eventDateTime: request.eventDateTime,
      },
      target,
      {
        status: proposedStatus,
        startAt: request.eventDateTime,
        endAt: proposedEnd,
        annotation: request.annotation ?? request.editReason ?? 'Carrier edit accepted',
        statusBeforeTarget: original ? statusInEffectAt(context.events, original.eventDateTime) : null,
        // B-72 — a proposed interval on an empty day falls back to OFF (§395.8(a): no record
        // is off duty), otherwise it would run on until the driver's next record.
        statusAfterInterval: proposedEnd
          ? (statusInEffectAt(context.events, proposedEnd) ?? (original ? null : 'OFF'))
          : null,
        special: meta.special,
        specialClearAt: this.nextActiveDutyAfter(context.events, request.eventDateTime, original?.id ?? null),
      },
    );

    await this.repo.runInTransaction((tx) =>
      this.writer.append(
        tx,
        {
          driverId: driver.id,
          sequenceKey: driver.id,
          timezone,
          vehicleId: original ? original.vehicleId : request.vehicleId,
          deviceId: original ? original.deviceId : request.deviceId,
          editedById: actor.id,
          editorType: EditorType.DRIVER,
          editReason: dto.note ?? request.editReason ?? null,
          // bugs.md B-076 — the proposal's location / engine hours are part of what the driver
          // accepted; they were dropped on accept before.
          location: locationOf(request),
          personalConveyance: meta.special === 'PC',
          totalVehicleMiles: request.totalVehicleMiles,
          totalEngineHours: toNumberOrNull(request.totalEngineHours),
        },
        rows,
      ),
    );

    await this.afterLogChange(driver.id, timezone, rows, anchor);
    await this.writeAudit(actor, 'LOG_EDIT_ACCEPTED', 'EldEvent', String(request.id), {
      before: { recordStatus: 3 },
      after: {
        recordStatus: 1,
        originalEventId: original ? String(original.id) : null,
        originalRecordStatus: original ? 2 : null,
        proposedSpecial: meta.special,
      },
      detail: original
        ? 'Driver accepted the carrier edit (49 CFR §395.30(c)(1)).'
        : 'Driver accepted the carrier-proposed record (49 CFR §395.30(c)(1)).',
    });
    await this.events.publish('log.edit_accepted', {
      driverId: driver.id,
      requestId: String(request.id),
    });

    return { id: String(request.id), status: 'ACCEPTED' as const, applied: true };
  }

  /** §9.1 step 3 — the driver rejects: the request is closed (4), the log is untouched. */
  async rejectEditRequest(requestId: string, actor: ContextUser, dto: ResolveEditRequestDto) {
    const { request, driver } = await this.loadPendingRequest(requestId, actor);
    const rows = planRejectEdit(
      {
        id: request.id,
        eventType: request.eventType,
        eventCode: request.eventCode,
        eventDateTime: request.eventDateTime,
      },
      dto.note ?? request.annotation ?? 'Edit rejected by driver',
    );

    await this.repo.runInTransaction((tx) =>
      this.writer.append(
        tx,
        {
          driverId: driver.id,
          sequenceKey: driver.id,
          timezone: driver.homeTerminalTimezone,
          vehicleId: request.vehicleId,
          deviceId: request.deviceId,
          editedById: actor.id,
          editorType: EditorType.DRIVER,
          editReason: dto.note ?? null,
        },
        rows,
      ),
    );

    await this.writeAudit(actor, 'LOG_EDIT_REJECTED', 'EldEvent', String(request.id), {
      before: { recordStatus: 3 },
      after: { recordStatus: 4 },
      detail: 'Driver rejected the carrier edit (49 CFR §395.30(c)(1)); the log is unchanged.',
    });
    await this.events.publish('log.edit_rejected', {
      driverId: driver.id,
      requestId: String(request.id),
    });

    return { id: String(request.id), status: 'REJECTED' as const, applied: false };
  }

  // =========================================================================
  // §9.3 — the driver's own correction (POST /mobile/log-entries)
  // =========================================================================

  async createLogEntry(driverId: string, dto: CreateLogEntryDto, actor: ContextUser) {
    const driver = await this.requireDriver(driverId);
    const timezone = driver.homeTerminalTimezone;
    const now = new Date();
    const context = await this.loadEditContext(driverId, timezone, dto.startAt, now);

    let target:
      | {
          id: bigint;
          eventType: number;
          eventCode: number;
          eventDateTime: Date;
          intervalEndAt: Date;
          statusBefore: DutyStatus | null;
        }
      | undefined;
    if (dto.originalEventId) {
      const original = await this.repo.findEventById(BigInt(dto.originalEventId));
      if (!original || original.driverId !== driverId) {
        throw new AppException(ERROR_CODES.NOT_FOUND, 'Original record not found for this driver.', 404);
      }
      target = {
        id: original.id,
        eventType: original.eventType,
        eventCode: original.eventCode,
        eventDateTime: original.eventDateTime,
        intervalEndAt: this.intervalEndOf(context.events, original, now),
        // B-049 — what the NEUTRALIZE row would re-state; `checkDriverSelfEdit` refuses 'D'.
        statusBefore: statusInEffectAt(context.events, original.eventDateTime),
      };
    }

    this.assertDrivingImmutable(
      checkDriverSelfEdit(
        { status: dto.status, startAt: dto.startAt, endAt: dto.endAt ?? null },
        context.driving,
        target,
        now,
      ),
    );

    const rows = planDriverSelfEdit(
      {
        status: dto.status,
        startAt: dto.startAt,
        endAt: dto.endAt ?? null,
        annotation: dto.annotation,
        statusBeforeTarget: target?.statusBefore ?? null,
        statusAfterInterval: dto.endAt ? statusInEffectAt(context.events, dto.endAt) : null,
      },
      target,
    );

    const ids = await this.repo.runInTransaction((tx) =>
      this.writer.append(
        tx,
        {
          driverId,
          sequenceKey: driverId,
          timezone,
          vehicleId: driver.assignedVehicleId,
          editedById: actor.id,
          editorType: EditorType.DRIVER,
          editReason: dto.annotation,
          location: dto.location ?? null,
          totalVehicleMiles: dto.odometerMi ?? null,
        },
        rows,
      ),
    );

    await this.afterLogChange(driverId, timezone, rows, dto.startAt);
    const newId = firstId(ids, rows, 'NEW_ACTIVE');
    await this.writeAudit(actor, 'LOG_SELF_EDIT', 'EldEvent', String(newId), {
      before: target ? { eventId: String(target.id), recordStatus: 1 } : null,
      after: {
        driverId,
        status: dto.status,
        startAt: dto.startAt.toISOString(),
        endAt: dto.endAt?.toISOString() ?? null,
        annotation: dto.annotation,
        recordOrigin: 2,
        recordStatus: 1,
      },
      detail: "Driver's own log correction (TZ §9.3) — certification invalidated.",
    });

    return {
      id: String(newId),
      driverId,
      status: dto.status,
      startAt: dto.startAt,
      endAt: dto.endAt ?? null,
      recordOrigin: 2,
      recordStatus: 1,
      applied: true,
      recertificationRequired: true,
    };
  }

  // =========================================================================
  // §9.2 — certification
  // =========================================================================

  async certify(dto: CertifyDto, actor: ContextUser) {
    // Anything that is not a driver token certifies "on behalf" and therefore needs
    // hosCertifyOnBehalf = FULL — an API-key principal must not slip past that check.
    const onBehalf = actor.type !== 'driver';
    const driverId = onBehalf ? dto.driverId : actor.id;
    if (!driverId) {
      throw new AppException(
        ERROR_CODES.VALIDATION_FAILED,
        '`driverId` is required when certifying on a driver\'s behalf.',
        422,
      );
    }
    if (onBehalf && (actor.permissions?.hosCertifyOnBehalf ?? 'NONE') !== 'FULL') {
      throw new AppException(
        ERROR_CODES.FORBIDDEN,
        'Certifying on a driver\'s behalf requires hosCertifyOnBehalf = FULL (TZ §9.2).',
        403,
        { key: 'hosCertifyOnBehalf', required: 'FULL' },
      );
    }

    const driver = await this.requireDriver(driverId);
    const timezone = driver.homeTerminalTimezone;
    const now = new Date();
    const todayKey = dayKey(timezone, now);
    const results = [];

    for (const date of dto.dates) {
      if (date > todayKey) {
        throw new AppException(
          ERROR_CODES.VALIDATION_FAILED,
          'A RODS day cannot be certified before it exists.',
          422,
          { date },
        );
      }
      // The header must exist and be current before it is certified (§5.8).
      await this.buildDays(driverId, date, date, now);
      const existing = await this.repo.findDailyLog(driverId, utcDate(date));
      const priorCount = existing?.certificationCount ?? 0;
      const eventCode = certificationEventCode(priorCount);

      const rows: AppendRow[] = [
        {
          kind: 'NEW_ACTIVE',
          eventType: CERTIFICATION_EVENT_TYPE,
          eventCode,
          at: now,
          recordStatus: 1,
          recordOrigin: onBehalf ? 3 : 2,
          supersedesId: null,
          annotation: `Certified RODS day ${date}`,
        },
      ];

      await this.repo.runInTransaction((tx) =>
        this.writer.append(
          tx,
          {
            driverId,
            sequenceKey: driverId,
            timezone,
            vehicleId: driver.assignedVehicleId,
            editedById: actor.id,
            editorType: onBehalf ? EditorType.USER : EditorType.DRIVER,
            editReason: onBehalf ? 'Certified on behalf of the driver' : null,
            // Appendix A carries the certified date as its own field; until the eRODS writer
            // lands (Phase 9) it is kept verbatim here so the link is never inferred.
            comment: `certifiedDate=${date}`,
          },
          rows,
        ),
      );

      const header = await this.repo.certify({
        driverId,
        logDate: utcDate(date),
        timezone,
        certifiedById: actor.id,
        certifierType: onBehalf ? 'USER' : 'DRIVER',
        signatureUrl: dto.signatureImageId ? `signatures/${dto.signatureImageId}` : null,
      });

      await this.writeAudit(actor, onBehalf ? 'LOG_CERTIFIED_ON_BEHALF' : 'LOG_CERTIFIED', 'DailyLog', header.id, {
        after: {
          driverId,
          date,
          certificationCount: header.certificationCount,
          eventCode,
          certifierType: header.certifierType,
        },
        detail: onBehalf
          ? 'Certified on behalf of the driver (hosCertifyOnBehalf = FULL, TZ §9.2 — audit mandatory).'
          : 'Driver certification (49 CFR §395.22(i)).',
      });

      results.push({
        date,
        certified: true,
        certificationCount: header.certificationCount,
        eventCode,
        certifiedAt: header.certifiedAt,
        certifierType: header.certifierType,
      });
    }

    await this.checkUncertifiedAlert(driverId, timezone, now);
    return { driverId, days: results };
  }

  /** §9.2 / §14 — `alert.uncertified_logs`, threshold 8 days, everywhere. */
  async checkUncertifiedAlert(driverId: string, timezone: string, now: Date): Promise<boolean> {
    const todayKey = dayKey(timezone, now);
    const dates = await this.repo.findUncertifiedDates(
      driverId,
      utcDate(addDays(todayKey, -30)),
      utcDate(addDays(todayKey, -1)),
    );
    const keys = dates.map((date) => dayKey('UTC', date));
    if (!uncertifiedAlertDue(keys, todayKey)) return false;
    await this.raiseAlert('alert.uncertified_logs', {
      driverId,
      thresholdDays: UNCERTIFIED_LOGS_ALERT_DAYS,
      oldest: keys[0],
      count: keys.length,
    });
    return true;
  }

  // =========================================================================
  // shared helpers
  // =========================================================================

  /**
   * §9.2 — every applied change invalidates the certification of every RODS day it touches,
   * refreshes the day header, and queues `hos.recalc` (never an inline recomputation, §8.4).
   */
  private async afterLogChange(
    driverId: string,
    timezone: string,
    rows: AppendRow[],
    earliest: Date,
  ): Promise<void> {
    const instants = [earliest, ...rows.map((row) => row.at)].sort((a, b) => a.getTime() - b.getTime());
    const keys = await this.recordLogChange(driverId, timezone, instants[0], instants[instants.length - 1]);
    await this.enqueueRecalc(driverId, keys[0]);
  }

  /**
   * §395.8(f) / TZ §9.2 — the ONE hook for "this driver's §395 records in `[from, to]` changed",
   * whoever wrote them (an accepted carrier edit, a driver self-edit, a mobile sync, and — bugs.md
   * B-050 — an unidentified-driving assignment or rejection). It voids the certification of every
   * RODS day in the span (home-terminal zone; the next day is included when the span runs past
   * midnight, so a certified day can never keep its certification after its records changed),
   * rebuilds the day headers (B-059), and publishes `log.changed` so the driver's clients refresh.
   * Returns the voided day keys, ascending. The caller queues `hos.recalc`.
   */
  async recordLogChange(driverId: string, timezone: string, from: Date, to: Date): Promise<string[]> {
    const [start, end] = from.getTime() <= to.getTime() ? [from, to] : [to, from];
    const keys = dayKeyRange(dayKey(timezone, start), dayKey(timezone, end));
    for (const key of keys) {
      await this.repo.invalidateCertification(driverId, utcDate(key), timezone);
    }
    // B-059 — the touched days' totals, plus the next day for a status carried over midnight.
    // `hos.recalc` then rebuilds everything forward to today.
    await this.rebuildDailyLogsForSpan(driverId, start, end);
    await this.events.publish('log.changed', { driverId, dates: keys });
    return keys;
  }

  /**
   * B-059 — rebuilds the `DailyLog` totals of every RODS day a record change in `[from, to]`
   * can alter: the day of `from` through the day after `to`, never past today, in the driver's
   * HOME TERMINAL zone. Certification is never touched. Best effort: the records are already
   * committed and `hos.recalc` rebuilds the same headers, so a failure is logged, not thrown.
   */
  async rebuildDailyLogsForSpan(driverId: string, from: Date, to: Date, now: Date = new Date()): Promise<number> {
    try {
      const driver = await this.requireDriver(driverId);
      const range = affectedHeaderRange(driver.homeTerminalTimezone, from, to, now);
      if (!range) return 0;
      const days = await this.buildDays(driverId, range.fromKey, range.toKey, now);
      return days.length;
    } catch (err) {
      this.logger.error({ err, driverId }, 'Failed to rebuild the DailyLog headers after a record change');
      return 0;
    }
  }

  private async enqueueRecalc(driverId: string, fromDate: string): Promise<void> {
    try {
      await this.hosRecalcQueue.add('hos.recalc', { driverId, fromDate });
    } catch (err) {
      // The records are already committed; a Redis blip must not fail the request (§8.4).
      this.logger.error({ err, driverId }, 'Failed to enqueue hos.recalc after a log change');
    }
  }

  private async raiseAlert(name: string, payload: Record<string, unknown>): Promise<void> {
    await this.events.publish(name, payload);
    try {
      await this.alertQueue.add(name, payload);
    } catch (err) {
      this.logger.error({ err, alert: name }, 'Failed to enqueue alert');
    }
  }

  private async writeAudit(
    actor: ContextUser,
    action: string,
    objectType: string,
    objectId: string,
    data: { before?: unknown; after?: unknown; detail?: string },
  ): Promise<void> {
    const ctx = RequestContext.get();
    try {
      await this.audit.insert({
        actorId: actor.id,
        actorType: actor.type === 'driver' ? EditorType.DRIVER : EditorType.USER,
        action,
        objectType,
        objectId,
        before: data.before ?? undefined,
        after: data.after ?? undefined,
        detail: data.detail,
        ip: ctx?.ip,
        userAgent: ctx?.userAgent,
      });
    } catch (err) {
      // §18 — audit must never break the operation it describes, but a RODS edit without its
      // audit row is a compliance defect, so it is logged at error level.
      this.logger.error({ err, action, objectId }, 'Failed to write the RODS audit entry');
    }
  }

  private async requireDriver(driverId: string) {
    const driver = await this.repo.findDriver(driverId);
    if (!driver) {
      throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404, { driverId });
    }
    return driver;
  }

  /** Events and active driving intervals around `at`, the input every edit rule needs. */
  private async loadEditContext(driverId: string, timezone: string, at: Date, now: Date) {
    const key = dayKey(timezone, at);
    const from = dayStart(timezone, addDays(key, -LOOKBACK_DAYS));
    const to = new Date(Math.max(dayEnd(timezone, addDays(key, 1)).getTime(), now.getTime()));
    const events = (await this.repo.findEvents(driverId, from, to)) as unknown as RodsEvent[];
    return { events, driving: drivingIntervals(events, now) };
  }

  /** End of the interval a record owns: the next ACTIVE record, or `now`. */
  private intervalEndOf(events: RodsEvent[], event: EldEvent, now: Date): Date {
    const next = activeRecords(events)
      .filter(
        (row) =>
          row.eventType === 1 &&
          row.eventDateTime.getTime() > event.eventDateTime.getTime(),
      )
      .sort((a, b) => a.eventDateTime.getTime() - b.eventDateTime.getTime())[0];
    return next ? next.eventDateTime : now;
  }

  /**
   * B-72 — the rule-engine view of a proposed NEW record: a non-driving pseudo target whose
   * implicit interval runs to the next active duty record (or `now`), so `checkEditProposal`
   * refuses anything that would overwrite recorded driving time.
   */
  private insertTarget(events: RodsEvent[], at: Date, now: Date) {
    return {
      eventType: 0,
      eventCode: 0,
      eventDateTime: at,
      intervalEndAt: this.nextActiveDutyAfter(events, at, null) ?? now,
    };
  }

  /** The first active duty-status record strictly after `at`, ignoring `excludeId`. */
  private nextActiveDutyAfter(events: RodsEvent[], at: Date, excludeId: bigint | null): Date | null {
    const next = activeRecords(events)
      .filter(
        (row) =>
          row.eventType === 1 &&
          row.eventDateTime.getTime() > at.getTime() &&
          (excludeId === null || row.id === undefined || String(row.id) !== String(excludeId)),
      )
      .sort((a, b) => a.eventDateTime.getTime() - b.eventDateTime.getTime())[0];
    return next ? next.eventDateTime : null;
  }

  /**
   * §12.5 / B-39 — tells the driver app a proposal is waiting: a socket event to `driver:{id}`
   * and the `alert.edit_request` job (AlertProcessor → IN_APP + FCM, kind EDIT_REQUEST).
   * `notifyDriver = false` suppresses only this push; the proposal is still listed by
   * `GET /mobile/log-edit-requests` and still needs the driver's answer (§395.30(c)(1)).
   */
  private async notifyProposal(
    driverId: string,
    requestId: string,
    data: { proposedStatus: DutyStatus; proposedSpecial: SpecialCategory; proposedStart: Date; notifyDriver: boolean },
  ): Promise<void> {
    const payload = {
      driverId,
      requestId,
      proposedStatus: data.proposedStatus,
      proposedSpecial: data.proposedSpecial,
      proposedStart: data.proposedStart.toISOString(),
    };
    await this.events.publish('log.edit_requested', { ...payload, notifyDriver: data.notifyDriver });
    if (!data.notifyDriver) return;
    await this.events.publish('realtime.push', {
      room: `driver:${driverId}`,
      event: 'log.edit_requested',
      payload,
    });
    await this.raiseAlert('alert.edit_request', payload);
  }

  private async loadPendingRequest(requestId: string, actor: ContextUser) {
    const request = await this.repo.findEventById(BigInt(requestId));
    if (!request || request.recordStatus !== 3) {
      throw new AppException(ERROR_CODES.NOT_FOUND, 'Edit request not found.', 404, { requestId });
    }
    if (!request.driverId) {
      throw new AppException(ERROR_CODES.NOT_FOUND, 'Edit request has no driver.', 404, { requestId });
    }
    // §395.30(c)(1) — only the driver whose log it is may accept or reject. Defence in depth
    // behind `@UseGuards(DriverGuard)` on the two routes: a non-driver principal (back-office
    // user, API key) must never be able to activate a proposal on the driver's behalf,
    // otherwise "edits are proposals only" (§23) is decided by the proposer.
    if (actor.type !== 'driver') {
      throw new AppException(
        ERROR_CODES.DRIVER_CONTEXT_REQUIRED,
        'Only the driver whose record it is may resolve this edit request (§395.30(c)(1)).',
        403,
      );
    }
    if (actor.id !== request.driverId) {
      throw new AppException(
        ERROR_CODES.FORBIDDEN,
        'Only the driver whose record it is may resolve this edit request.',
        403,
      );
    }
    const markers = await this.repo.findSupersedingEvents([request.id]);
    if (markers.length) {
      throw new AppException(
        ERROR_CODES.EDIT_ALREADY_RESOLVED,
        'This edit request has already been accepted or rejected.',
        409,
        { requestId },
      );
    }
    const driver = await this.requireDriver(request.driverId);
    // B-72 — a proposed NEW record has no original to replace.
    if (request.supersedesId === null) return { request, original: null, driver };
    const original = await this.repo.findEventById(request.supersedesId);
    if (!original) {
      throw new AppException(ERROR_CODES.NOT_FOUND, 'Original record not found.', 404);
    }
    return { request, original, driver };
  }

  private assertDrivingImmutable(reason: DrivingImmutabilityReason | null): void {
    if (!reason) return;
    throw new AppException(
      ERROR_CODES.DRIVING_TIME_IMMUTABLE,
      IMMUTABILITY_DETAIL[reason],
      422,
      { reason },
    );
  }

  private toEditRequestView(request: EldEvent, markers: EldEvent[]): EditRequestView {
    const marker = markers.find((row) => String(row.supersedesId) === String(request.id));
    const status = !marker ? 'PENDING' : marker.recordStatus === 4 ? 'REJECTED' : 'ACCEPTED';
    const meta = parseProposalMeta(request.comment);
    return {
      id: String(request.id),
      driverId: request.driverId as string,
      status,
      kind: request.supersedesId === null ? 'INSERT' : 'EDIT',
      originalEventId: request.supersedesId === null ? null : String(request.supersedesId),
      proposedStatus: DUTY_STATUS_BY_CODE[request.eventCode] ?? null,
      proposedSpecial: meta.special,
      proposedStart: request.eventDateTime,
      proposedEnd: meta.proposedEnd,
      locationName: request.locationName,
      annotation: request.annotation,
      requestedById: request.editedById,
      requestedAt: request.createdAt,
      resolvedAt: marker ? marker.createdAt : null,
    };
  }

  private toEventView(event: EldEvent) {
    return {
      id: String(event.id),
      eventType: event.eventType,
      eventCode: event.eventCode,
      eventSequenceId: event.eventSequenceId,
      eventDateTime: event.eventDateTime,
      recordStatus: event.recordStatus,
      recordOrigin: event.recordOrigin,
      status: event.eventType === 1 ? (DUTY_STATUS_BY_CODE[event.eventCode] ?? null) : null,
      locationName: event.locationName,
      totalVehicleMiles: event.totalVehicleMiles,
      /** B-38 — Appendix A "total engine hours" (W-08 ENGINE HRS column). */
      totalEngineHours: toNumberOrNull(event.totalEngineHours),
      annotation: event.annotation,
      comment: event.comment,
      supersedesId: event.supersedesId === null ? null : String(event.supersedesId),
      editedById: event.editedById,
      editorType: event.editorType,
      editReason: event.editReason,
      vehicleId: event.vehicleId,
    };
  }
}

/** "YYYY-MM-DD" → the UTC midnight Prisma stores in a `@db.Date` column. */
function utcDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

function dayKeyRange(from: string, to: string): string[] {
  const keys: string[] = [];
  let key = from;
  for (let guard = 0; guard < MAX_RANGE_DAYS; guard += 1) {
    keys.push(key);
    if (key >= to) break;
    key = addDays(key, 1);
  }
  return keys;
}

/** B-39 / B-076 — the location a proposal row carries, for the record the driver accepts. */
function locationOf(event: EldEvent): { lat?: number; lon?: number; name?: string } | null {
  const lat = toNumberOrNull(event.latitude);
  const lon = toNumberOrNull(event.longitude);
  const hasCoordinates = lat !== null && lon !== null;
  if (!hasCoordinates && !event.locationName) return null;
  return {
    ...(hasCoordinates && { lat, lon }),
    ...(event.locationName && { name: event.locationName }),
  };
}

/** Prisma `Decimal` / number → number; `null`/`undefined`/non-finite → `null`. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstId(ids: Map<string, bigint>, rows: AppendRow[], kind?: string): bigint {
  for (let index = 0; index < rows.length; index += 1) {
    if (kind && rows[index].kind !== kind) continue;
    const id = ids.get(`${rows[index].kind}:${index}`);
    if (id !== undefined) return id;
  }
  return 0n;
}
