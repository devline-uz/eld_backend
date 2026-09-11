import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Device, Prisma, Vehicle } from '@prisma/client';
import { Queue } from 'bullmq';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import {
  applyOdometerOffsetMi,
  coarsenLocation,
  computeOdometerOffsetMi,
  distanceMi,
  isOdometerAnomaly,
  kmToMi,
} from '../../common/units';
import { EventBusService } from '../../core/events/event-bus.service';
import { QUEUES } from '../../core/queue/queue.constants';
import { TelemetryService } from '../telemetry/telemetry.service';
import { computeChecksum, verifyChecksum } from './checksum';
import {
  clockDriftSec,
  detectMissingData,
  isBleDisconnectedTooLong,
  isDeviceBacklog,
  isTimingMalfunction,
  runWindowChecks,
  AUTO_CHECK_WINDOW_SEC,
  DetectedCode,
} from './detectors';
import {
  DIAGNOSTIC,
  EVENT_TYPE,
  MALFUNCTION,
  MALFUNCTION_EVENT_CODE,
  PC_YM_CODE,
  RECORD_ORIGIN,
} from './event-codes';
import {
  IngestBleStateDto,
  IngestDeviceStatusDto,
  IngestEventDto,
  IngestEventsDto,
  IngestTelemetryDto,
} from './dto/ingest.dto';
import { IngestRepository, IngestTx } from './ingest.repository';
import { resolveStoredEventOwner } from './ownership';

export interface IngestWarning {
  uuid?: string;
  code: string;
  detail: string;
}

export interface IngestEventsResult {
  accepted: number;
  duplicates: number;
  /** §5.5 — the sequence numbers this batch consumed, per sequence key. */
  sequenceIds: Record<string, number[]>;
  warnings: IngestWarning[];
  malfunctions: string[];
  diagnostics: string[];
  unidentifiedSegmentIds: string[];
  /** §7.4 rule 2 — drivers asked to confirm ownership of device-stored events. */
  confirmationRequests: string[];
}

interface IngestContext {
  device: Device;
  vehicle: Vehicle;
  driverId: string;
}

interface PreparedEvent {
  row: Prisma.EldEventCreateManyInput;
  sequenceKey: string;
  rule?: 1 | 2 | 3;
  requiresConfirmation: boolean;
  unidentified: boolean;
  fromStoredEvents: boolean;
  latRaw: number | null;
  lonRaw: number | null;
}

const UNIDENTIFIED_KEY = (vehicleId: string): string => `unidentified:${vehicleId}`;

/**
 * TZ §7 — the gateway ingest path. Everything here is driven by the APP (driver JWT, §3.1):
 * the PT30 itself has no network. Events arrive LATE, so every rule keys off `eventDateTime`
 * and never `createdAt`/`receivedAt`.
 *
 * The governing principle (§7.3, note "Nega hodisa rad etilmaydi"): an event the ELD recorded
 * is NEVER rejected for data quality. Bad checksum, drifted clock, impossible odometer — the
 * event is stored and flagged with a malfunction/diagnostic. Only schema violations fail.
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly repo: IngestRepository,
    private readonly telemetry: TelemetryService,
    private readonly events: EventBusService,
    @InjectQueue(QUEUES.HOS_RECALC) private readonly hosRecalcQueue: Queue,
    @InjectQueue(QUEUES.ALERT) private readonly alertQueue: Queue,
    @InjectQueue(QUEUES.SAFETY_DETECT) private readonly safetyDetectQueue: Queue,
  ) {}

  // =========================================================================
  // POST /ingest/events
  // =========================================================================

  async ingestEvents(dto: IngestEventsDto, driverId: string): Promise<IngestEventsResult> {
    const ctx = await this.resolveContext(dto.deviceSerial, driverId, dto.vehicleId);
    const now = new Date();
    const warnings: IngestWarning[] = [];

    const ordered = [...dto.batch].sort(
      (a, b) => a.eventDateTime.getTime() - b.eventDateTime.getTime(),
    );

    const result = await this.repo.runInTransaction(async (tx) => {
      const existing = await this.repo.findExistingUuids(
        tx,
        ordered.map((e) => e.uuid),
      );
      const fresh = ordered.filter((e) => !existing.has(e.uuid));

      const prepared: PreparedEvent[] = [];
      const generated: PreparedEvent[] = [];
      let pcActive = await this.repo.findPcStateBefore(tx, driverId, ordered[0].eventDateTime);
      let lastRawKm = await this.repo.findLastRawOdometerKm(tx, ctx.vehicle.id, ordered[0].eventDateTime);
      let offsetMi = ctx.vehicle.odometerOffsetMi;
      let calibratedNow: number | null = null;
      let odometerAnomalySeen = false;

      for (const event of fresh) {
        // --- §7.3 rule 9 — Personal Conveyance state drives location precision.
        if (event.eventType === EVENT_TYPE.PC_YM_INDICATION) {
          pcActive = event.eventCode === PC_YM_CODE.PC;
        }

        // --- §7.3 rule 4 — checksum computed and verified (never a rejection).
        const verdict = verifyChecksum(event, event.checksum);
        if (!verdict.ok) {
          warnings.push({
            uuid: event.uuid,
            code: ERROR_CODES.CHECKSUM_MISMATCH,
            detail:
              verdict.reason === 'MISSING'
                ? 'No checksum supplied; server-computed checksum stored, diagnostic 3 logged.'
                : `Checksum mismatch (expected ${verdict.expected}, got ${verdict.supplied}).`,
          });
        }

        // --- §7.3 rule 5 / §7.8 T — clock drift, single 10-minute threshold.
        const driftSec = clockDriftSec(event.eventDateTime, now);
        const timing = isTimingMalfunction(driftSec);
        if (timing) {
          warnings.push({
            uuid: event.uuid,
            code: 'CLOCK_DRIFT',
            detail: `Device clock is ${driftSec}s from server UTC; malfunction T logged.`,
          });
        }

        // --- §4.3 / §7.3 rule 7 — odometer.
        let totalVehicleMiles: number | null = null;
        let rawKm: number | null = null;
        let anomaly = false;
        if (event.rawDeviceOdometerKm !== null && event.rawDeviceOdometerKm !== undefined) {
          rawKm = Math.round(event.rawDeviceOdometerKm);
          const deviceMi = kmToMi(rawKm);
          if (ctx.vehicle.odometerCalibratedAt === null && calibratedNow === null) {
            offsetMi = computeOdometerOffsetMi({
              odometerMi: ctx.vehicle.odometerMi,
              deviceOdometerMi: deviceMi,
            });
            calibratedNow = deviceMi;
          }
          totalVehicleMiles = applyOdometerOffsetMi(deviceMi, offsetMi);
          if (lastRawKm !== null) {
            anomaly = isOdometerAnomaly(kmToMi(lastRawKm), deviceMi);
          }
          if (anomaly) {
            odometerAnomalySeen = true;
            warnings.push({
              uuid: event.uuid,
              code: ERROR_CODES.ODOMETER_ANOMALY,
              detail: `Device odometer moved ${kmToMi(lastRawKm ?? 0)} mi → ${deviceMi} mi; diagnostic 3 logged.`,
            });
          }
          lastRawKm = rawKm;
        }

        // --- §7.8 diagnostic 3 — checksum / mandatory data / odometer.
        const missingFields = mandatoryFieldsMissing(event);
        const missing = detectMissingData({
          checksumOk: verdict.ok,
          missingFields,
          odometerAnomaly: anomaly,
        });

        // --- §7.4 — ownership of device-stored events (ordered ladder, first match wins).
        let ownerId: string | null = driverId;
        let recordOrigin: number = event.recordOrigin;
        let rule: 1 | 2 | 3 | undefined;
        let requiresConfirmation = false;
        let unidentified = false;

        if (event.wasStoredOnDevice) {
          const window = await this.repo.findSessionWindow(tx, ctx.vehicle.id, event.eventDateTime);
          const decision = resolveStoredEventOwner(event.eventDateTime, window);
          ownerId = decision.driverId;
          recordOrigin = decision.recordOrigin;
          rule = decision.rule;
          requiresConfirmation = decision.requiresConfirmation;
          unidentified = decision.createsUnidentifiedSegment;
        } else if (event.recordOrigin === RECORD_ORIGIN.UNIDENTIFIED) {
          // Live unidentified driving: the engine ran with nobody logged in.
          ownerId = null;
          unidentified = true;
        }

        // --- §7.3 rule 9 — coarsen BEFORE storage; raw coordinates are stored NOWHERE.
        const precisionMi = pcActive ? 10 : 1;
        const coords =
          event.latitude !== null && event.latitude !== undefined && event.longitude !== null && event.longitude !== undefined
            ? coarsenLocation(
                { lat: event.latitude, lon: event.longitude },
                pcActive ? 'TEN_MILE' : 'ONE_MILE',
              )
            : null;

        const sequenceKey = ownerId ?? UNIDENTIFIED_KEY(ctx.vehicle.id);

        prepared.push({
          sequenceKey,
          rule,
          requiresConfirmation,
          unidentified,
          fromStoredEvents: event.wasStoredOnDevice,
          latRaw: event.latitude ?? null,
          lonRaw: event.longitude ?? null,
          row: {
            uuid: event.uuid,
            driverId: ownerId,
            vehicleId: ctx.vehicle.id,
            deviceId: ctx.device.id,
            eventType: event.eventType,
            eventCode: event.eventCode,
            eventSequenceId: 0, // assigned below, once, under the advisory lock
            eventDateTime: event.eventDateTime,
            timezoneOffset: event.timezoneOffset,
            recordStatus: event.recordStatus,
            recordOrigin,
            latitude: coords?.lat ?? null,
            longitude: coords?.lon ?? null,
            locationPrecisionMi: precisionMi,
            locationName: event.locationName ?? null,
            locationSource: event.locationSource ?? null,
            distanceSinceLastValidCoords: event.distanceSinceLastValidCoords ?? null,
            totalVehicleMiles,
            rawDeviceOdometerKm: rawKm,
            totalEngineHours: event.totalEngineHours ?? null,
            malfunctionCode: timing ? MALFUNCTION.TIMING : (event.malfunctionCode ?? null),
            diagnosticCode: missing ? DIAGNOSTIC.MISSING_DATA : (event.diagnosticCode ?? null),
            timeDriftSec: driftSec,
            annotation: event.annotation ?? null,
            comment: event.comment ?? null,
            wasStoredOnDevice: event.wasStoredOnDevice,
            uploadedByDriverId: driverId,
            // The STORED checksum is always the server-computed one, so the record stays
            // independently verifiable even when the app sent a corrupt value.
            checksum: verdict.expected,
          },
        });

        // §5.5 / §7.8 — a malfunction or diagnostic is itself an eventType 7 record.
        if (timing) {
          generated.push(
            this.buildCodeEvent(ctx, ownerId, event.eventDateTime, event.timezoneOffset, {
              kind: 'malfunction',
              code: MALFUNCTION.TIMING,
              reason: `clock drift ${driftSec}s`,
            }),
          );
        }
        if (missing) {
          generated.push(
            this.buildCodeEvent(ctx, ownerId, event.eventDateTime, event.timezoneOffset, missing),
          );
        }
      }

      const all = [...prepared, ...generated];
      await this.assignSequenceIds(tx, all);

      const months = [...new Set(all.map((p) => monthStart(p.row.eventDateTime as Date)))];
      await this.repo.ensurePartitions(tx, months);

      const accepted = await this.repo.insertEvents(
        tx,
        all.map((p) => p.row),
      );

      // §7.4 rule 3 — device-stored (or live) driving nobody owns becomes a segment.
      const unidentifiedSegmentIds = await this.createUnidentifiedSegments(tx, ctx, all);

      // §4.3 — keep the vehicle's device odometer / calibration current.
      const vehicleUpdate: Prisma.VehicleUpdateInput = {};
      if (lastRawKm !== null) vehicleUpdate.deviceOdometerMi = kmToMi(lastRawKm);
      if (calibratedNow !== null) {
        vehicleUpdate.odometerOffsetMi = offsetMi;
        vehicleUpdate.odometerCalibratedAt = now;
      }
      if (Object.keys(vehicleUpdate).length) {
        await this.repo.updateVehicle(tx, ctx.vehicle.id, vehicleUpdate);
      }

      const lastEventAt = ordered[ordered.length - 1].eventDateTime;
      await this.repo.updateDevice(tx, ctx.device.id, { lastEventAt, lastSeenAt: now });

      return {
        accepted,
        duplicates: ordered.length - fresh.length,
        prepared: all,
        unidentifiedSegmentIds,
        odometerAnomalySeen,
      };
    });

    const sequenceIds: Record<string, number[]> = {};
    for (const item of result.prepared) {
      (sequenceIds[item.sequenceKey] ??= []).push(item.row.eventSequenceId);
    }

    const confirmationRequests = [
      ...new Set(
        result.prepared
          .filter((p) => p.requiresConfirmation && p.row.driverId)
          .map((p) => p.row.driverId as string),
      ),
    ];

    // --- after commit: §7.3 rule 10 + §7.8 windowed checks + alerts ---------
    const windowCodes = await this.runAutoChecks(ctx, now);

    if (result.odometerAnomalySeen) {
      await this.raiseAlert('alert.odometer_anomaly', {
        vehicleId: ctx.vehicle.id,
        deviceSerial: ctx.device.serial,
        driverId,
      });
    }
    for (const driver of confirmationRequests) {
      await this.raiseAlert('alert.unidentified_confirmation_requested', {
        driverId: driver,
        vehicleId: ctx.vehicle.id,
      });
    }
    for (const segmentId of result.unidentifiedSegmentIds) {
      await this.raiseAlert('alert.unidentified_driving', {
        segmentId,
        vehicleId: ctx.vehicle.id,
      });
    }

    if (result.accepted > 0) {
      await this.enqueueRecalc(result.prepared);
      await this.events.publish('realtime.push', {
        room: `vehicle:${ctx.vehicle.id}`,
        event: 'eld.events_ingested',
        payload: { vehicleId: ctx.vehicle.id, count: result.accepted },
      });
    }

    const malfunctions = [
      ...new Set(
        result.prepared
          .map((p) => p.row.malfunctionCode)
          .filter((c): c is string => Boolean(c))
          .concat(windowCodes.filter((c) => c.kind === 'malfunction').map((c) => c.code)),
      ),
    ];
    const diagnostics = [
      ...new Set(
        result.prepared
          .map((p) => p.row.diagnosticCode)
          .filter((c): c is string => Boolean(c))
          .concat(windowCodes.filter((c) => c.kind === 'diagnostic').map((c) => c.code)),
      ),
    ];

    return {
      accepted: result.accepted,
      duplicates: result.duplicates,
      sequenceIds,
      warnings,
      malfunctions,
      diagnostics,
      unidentifiedSegmentIds: result.unidentifiedSegmentIds,
      confirmationRequests,
    };
  }

  // =========================================================================
  // POST /ingest/telemetry
  // =========================================================================

  async ingestTelemetry(
    dto: IngestTelemetryDto,
    driverId: string,
  ): Promise<{ accepted: number; duplicates: number; denserThanContract: number }> {
    const ctx = await this.resolveContext(dto.deviceSerial, driverId, dto.vehicleId);
    const earliest = dto.points.reduce(
      (min, p) => (p.time < min ? p.time : min),
      dto.points[0].time,
    );
    const pcActive = await this.repo.runInTransaction((tx) =>
      this.repo.findPcStateBefore(tx, driverId, earliest),
    );

    const stored = await this.telemetry.store(dto.points, {
      vehicleId: ctx.vehicle.id,
      driverId,
      odometerOffsetMi: ctx.vehicle.odometerOffsetMi,
      pcActive,
    });

    if (stored.accepted > 0) {
      await this.events.publish('realtime.push', {
        room: `vehicle:${ctx.vehicle.id}`,
        event: 'telemetry.point',
        payload: { vehicleId: ctx.vehicle.id, count: stored.accepted },
      });
      // Phase 10 — harsh-event + geofence detection runs in the worker container, never
      // inline in the request (TZ §3.3). Best-effort: a Redis blip must not fail ingest.
      try {
        await this.safetyDetectQueue.add('safety.detect', {
          vehicleId: ctx.vehicle.id,
          driverId,
          points: dto.points.map((p) => ({
            time: p.time,
            latitude: p.latitude,
            longitude: p.longitude,
            speedKmh: p.speedKmh,
            headingDeg: p.headingDeg,
          })),
        });
      } catch (err) {
        this.logger.error({ err }, 'Failed to enqueue safety.detect');
      }
    }
    return stored;
  }

  // =========================================================================
  // POST /ingest/ble-state  (§7.6)
  // =========================================================================

  async recordBleState(
    dto: IngestBleStateDto,
    driverId: string,
  ): Promise<{ bleState: string; disconnectedAlert: boolean }> {
    const ctx = await this.resolveContext(dto.deviceSerial, driverId);
    const now = dto.at ?? new Date();

    // OUT_OF_RANGE is normal (driver walked away with the phone) — the alert is time-based.
    const disconnectedAlert = isBleDisconnectedTooLong(dto.state, ctx.device.lastSeenAt, now);

    await this.repo.updateDeviceOutsideTx(ctx.device.id, {
      bleState: dto.state,
      ...(dto.state === 'CONNECTED' && { lastSeenAt: now }),
    });

    if (disconnectedAlert) {
      await this.raiseAlert('alert.eld_disconnected', {
        deviceSerial: ctx.device.serial,
        vehicleId: ctx.device.vehicleId,
        state: dto.state,
        lastSeenAt: ctx.device.lastSeenAt,
      });
    }
    await this.events.publish('realtime.push', {
      room: `vehicle:${ctx.device.vehicleId ?? 'unassigned'}`,
      event: 'device.ble_state',
      payload: { deviceSerial: ctx.device.serial, state: dto.state },
    });

    return { bleState: dto.state, disconnectedAlert };
  }

  // =========================================================================
  // POST /ingest/device-status  (§7.7)
  // =========================================================================

  async recordDeviceStatus(
    dto: IngestDeviceStatusDto,
    driverId: string,
  ): Promise<{ storedEventsCount: number; backlogAlert: boolean; codes: string[] }> {
    const ctx = await this.resolveContext(dto.deviceSerial, driverId);
    const now = new Date();

    await this.repo.updateDeviceOutsideTx(ctx.device.id, {
      storedEventsCount: dto.storedEventsCount,
      lastSeenAt: now,
      ...(dto.firmware && { firmware: dto.firmware }),
    });

    const backlogAlert = isDeviceBacklog(dto.storedEventsCount);
    if (backlogAlert) {
      await this.raiseAlert('alert.device_backlog', {
        deviceSerial: ctx.device.serial,
        vehicleId: ctx.device.vehicleId,
        storedEventsCount: dto.storedEventsCount,
      });
    }

    const codes = ctx.device.vehicleId
      ? await this.runAutoChecks(
          { device: ctx.device, vehicle: { id: ctx.device.vehicleId }, driverId },
          now,
          {
            storedEventsCount: dto.storedEventsCount,
            recordsLost: dto.recordsLost,
            consecutiveTransferFailures: dto.consecutiveTransferFailures,
          },
        )
      : [];

    return {
      storedEventsCount: dto.storedEventsCount,
      backlogAlert,
      codes: codes.map((c) => `${c.kind === 'malfunction' ? 'M' : 'D'}:${c.code}`),
    };
  }

  // =========================================================================
  // internals
  // =========================================================================

  /**
   * `deviceSerial` and `vehicleId` are claims made by a mobile client — never trusted.
   * The device must exist, be paired with the claimed unit, and the driver must actually be
   * associated with that unit (assignment, or an open login session on it).
   */
  private async resolveContext(
    deviceSerial: string,
    driverId: string,
    claimedVehicleId?: string,
  ): Promise<IngestContext> {
    const device = await this.repo.findDeviceBySerial(deviceSerial);
    if (!device) {
      throw new AppException(ERROR_CODES.UNKNOWN_DEVICE, `Unknown device "${deviceSerial}".`, 404);
    }

    const vehicleId = claimedVehicleId ?? device.vehicleId;
    if (!vehicleId) {
      // BLE/status heartbeats from an unpaired device carry no vehicle claim to verify.
      return { device, vehicle: { id: '', odometerOffsetMi: 0 } as Vehicle, driverId };
    }
    if (device.vehicleId !== vehicleId) {
      throw AppException.forbidden('Device is not paired with the claimed unit.', {
        deviceSerial,
        vehicleId,
      });
    }

    const vehicle = await this.repo.findVehicle(vehicleId);
    if (!vehicle) {
      throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404);
    }

    const assigned = await this.repo.findDriverAssignedVehicleId(driverId);
    if (assigned !== vehicleId) {
      const hasSession = await this.repo.hasOpenSessionOnVehicle(driverId, vehicleId, new Date());
      if (!hasSession) {
        throw AppException.forbidden('Driver is not associated with this unit.', {
          vehicleId,
          deviceSerial,
        });
      }
    }
    return { device, vehicle, driverId };
  }

  /** §5.5 / §7.3 rule 8 — one allocation per sequence key, inside the batch transaction. */
  private async assignSequenceIds(tx: IngestTx, items: PreparedEvent[]): Promise<void> {
    const byKey = new Map<string, PreparedEvent[]>();
    for (const item of items) {
      const list = byKey.get(item.sequenceKey) ?? [];
      list.push(item);
      byKey.set(item.sequenceKey, list);
    }
    for (const [key, list] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      list.sort(
        (a, b) =>
          (a.row.eventDateTime as Date).getTime() - (b.row.eventDateTime as Date).getTime(),
      );
      const ids = await this.repo.allocateSequenceIds(tx, key, list.length);
      list.forEach((item, index) => {
        item.row.eventSequenceId = ids[index];
      });
    }
  }

  /** §7.4 rule 3 / §5.9 — one segment per contiguous run of unidentified events. */
  private async createUnidentifiedSegments(
    tx: IngestTx,
    ctx: IngestContext,
    items: PreparedEvent[],
  ): Promise<string[]> {
    const unidentified = items
      .filter((i) => i.unidentified)
      .sort(
        (a, b) =>
          (a.row.eventDateTime as Date).getTime() - (b.row.eventDateTime as Date).getTime(),
      );
    if (!unidentified.length) return [];

    const uuids = unidentified.map((i) => i.row.uuid);
    const eventIds = await this.repo.findEventIdsByUuids(tx, uuids);

    const startAt = unidentified[0].row.eventDateTime as Date;
    const endAt = unidentified[unidentified.length - 1].row.eventDateTime as Date;
    const first = unidentified[0];
    const last = unidentified[unidentified.length - 1];
    const miles =
      first.latRaw !== null && first.lonRaw !== null && last.latRaw !== null && last.lonRaw !== null
        ? distanceMi(
            { lat: first.latRaw, lon: first.lonRaw },
            { lat: last.latRaw, lon: last.lonRaw },
          )
        : 0;

    const segment = await this.repo.createUnidentifiedSegment(tx, {
      vehicleId: ctx.vehicle.id,
      startAt,
      endAt,
      durationSec: Math.max(0, Math.round((endAt.getTime() - startAt.getTime()) / 1000)),
      distanceMi: miles,
      eventIds,
      fromStoredEvents: unidentified.some((i) => i.fromStoredEvents),
    });
    return [segment.id];
  }

  /** §7.8 — windowed malfunction/diagnostic detection, logged once per 24-hour window. */
  private async runAutoChecks(
    ctx: { device: Device; vehicle: Pick<Vehicle, 'id'>; driverId: string },
    now: Date,
    deviceState?: {
      storedEventsCount: number;
      recordsLost: boolean;
      consecutiveTransferFailures: number;
    },
  ): Promise<DetectedCode[]> {
    if (!ctx.vehicle.id) return [];
    const since = new Date(now.getTime() - AUTO_CHECK_WINDOW_SEC * 1000);
    const stats = await this.repo.collectWindowStats(ctx.vehicle.id, now);
    const detected = runWindowChecks({
      ...stats,
      storedEventsCount: deviceState?.storedEventsCount ?? ctx.device.storedEventsCount,
      recordsLost: deviceState?.recordsLost ?? false,
      consecutiveTransferFailures: deviceState?.consecutiveTransferFailures ?? 0,
    });
    if (!detected.length) return [];

    const alreadyLogged = await this.repo.findLoggedCodesInWindow(ctx.vehicle.id, since);
    const fresh = detected.filter(
      (c) => !alreadyLogged.has(`${c.kind === 'malfunction' ? 'M' : 'D'}:${c.code}`),
    );
    if (!fresh.length) return detected;

    await this.repo.runInTransaction(async (tx) => {
      const rows = fresh.map((code) =>
        this.buildCodeEvent(
          { device: ctx.device, vehicle: ctx.vehicle },
          ctx.driverId,
          now,
          0,
          code,
        ),
      );
      await this.assignSequenceIds(tx, rows);
      await this.repo.ensurePartitions(tx, [monthStart(now)]);
      await this.repo.insertEvents(
        tx,
        rows.map((r) => r.row),
      );
    });

    for (const code of fresh) {
      await this.raiseAlert(
        code.kind === 'malfunction' ? 'alert.eld_malfunction' : 'alert.eld_diagnostic',
        { vehicleId: ctx.vehicle.id, code: code.code, reason: code.reason },
      );
    }
    return detected;
  }

  /** §5.5 — malfunctions and diagnostics are recorded as eventType 7 records. */
  private buildCodeEvent(
    ctx: { device: Device; vehicle: Pick<Vehicle, 'id'> },
    driverId: string | null,
    at: Date,
    timezoneOffset: number,
    code: DetectedCode,
  ): PreparedEvent {
    const isMalfunction = code.kind === 'malfunction';
    const uuid = `auto-${code.kind}-${code.code}-${ctx.vehicle.id}-${at.getTime()}`;
    const base = {
      uuid,
      eventType: EVENT_TYPE.MALFUNCTION_DIAGNOSTIC,
      eventCode: isMalfunction
        ? MALFUNCTION_EVENT_CODE.MALFUNCTION_LOGGED
        : MALFUNCTION_EVENT_CODE.DIAGNOSTIC_LOGGED,
      eventDateTime: at,
      timezoneOffset,
      recordStatus: 1,
      recordOrigin: RECORD_ORIGIN.ELD_AUTOMATIC,
      malfunctionCode: isMalfunction ? code.code : null,
      diagnosticCode: isMalfunction ? null : code.code,
      annotation: code.reason.slice(0, 60),
    };
    return {
      sequenceKey: driverId ?? UNIDENTIFIED_KEY(ctx.vehicle.id),
      requiresConfirmation: false,
      unidentified: false,
      fromStoredEvents: false,
      latRaw: null,
      lonRaw: null,
      row: {
        ...base,
        driverId,
        vehicleId: ctx.vehicle.id,
        deviceId: ctx.device.id,
        eventSequenceId: 0,
        // Auto-generated records are checksummed exactly like device ones (§23).
        checksum: computeChecksum(base),
        locationPrecisionMi: 1,
      },
    };
  }

  /** §7.3 rule 10 — recalculation is queued per affected driver, keyed on `eventDateTime`. */
  private async enqueueRecalc(items: PreparedEvent[]): Promise<void> {
    const perDriver = new Map<string, { from: Date; to: Date }>();
    for (const item of items) {
      const driverId = item.row.driverId;
      if (!driverId) continue;
      const at = item.row.eventDateTime as Date;
      const span = perDriver.get(driverId);
      if (!span) perDriver.set(driverId, { from: at, to: at });
      else {
        if (at < span.from) span.from = at;
        if (at > span.to) span.to = at;
      }
    }
    for (const [driverId, span] of perDriver) {
      try {
        await this.hosRecalcQueue.add('hos.recalc', {
          driverId,
          from: span.from.toISOString(),
          to: span.to.toISOString(),
        });
      } catch (err) {
        // Ingest must never fail because Redis blinked — the events are already committed.
        this.logger.error({ err, driverId }, 'Failed to enqueue hos.recalc');
      }
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
}

/** §395 Appendix A mandatory data elements that the payload may legitimately omit only for
 * some event types — anything missing here becomes diagnostic `3` (§7.8), never a rejection. */
function mandatoryFieldsMissing(event: IngestEventDto): string[] {
  const missing: string[] = [];
  const positionRequired =
    event.eventType === EVENT_TYPE.DUTY_STATUS_CHANGE ||
    event.eventType === EVENT_TYPE.INTERMEDIATE_LOG;
  if (positionRequired && (event.latitude === null || event.latitude === undefined)) {
    missing.push('latitude');
  }
  if (positionRequired && (event.longitude === null || event.longitude === undefined)) {
    missing.push('longitude');
  }
  if (
    event.eventType === EVENT_TYPE.DUTY_STATUS_CHANGE &&
    (event.rawDeviceOdometerKm === null || event.rawDeviceOdometerKm === undefined)
  ) {
    missing.push('rawDeviceOdometerKm');
  }
  return missing;
}

function monthStart(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
