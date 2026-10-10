import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { EventBusService } from '../../core/events/event-bus.service';
import { QUEUES } from '../../core/queue/queue.constants';
import {
  isHarshType,
  rawEventKey,
  toRawEventRow,
  toSafetyEventRow,
} from './device-events.mapper';
import type { DeviceRawEventDto, IngestDeviceEventsDto } from './dto/ingest.dto';
import { IngestRepository } from './ingest.repository';
import { IngestService } from './ingest.service';
import { resolveStoredEventOwner } from './ownership';

export interface DeviceEventsResult {
  /** Events in the payload. */
  received: number;
  /** Rows newly inserted into `DeviceRawEvent`. */
  stored: number;
  /** Already stored (same `(occurredAt, seq)` for this device) or repeated inside the payload. */
  duplicates: number;
  /** `SafetyEvent` rows created from newly stored `HARSH_*` events. */
  safetyEvents: number;
}

/**
 * `POST /ingest/device-events` — the PT SDK 6.11 raw `TelemetryEvent` log (power, ignition,
 * engine, trip, periodic, BLE, bus and the device's own MEMS harsh-driving detections).
 *
 * Same trust model as every ingest route: the app (driver JWT) posts it, `deviceSerial` and
 * `vehicleId` are verified through `IngestService.resolveContext`. Idempotent on the SDK ACK
 * key `(deviceId, occurredAt, seq)`; the whole batch commits in one transaction. Raw events are
 * never rejected for data quality — an unknown type label is stored as `UNKNOWN`.
 *
 * Ownership (D-135): a live event belongs to the uploading driver. A device-stored harsh event
 * (`live: false`) goes through the §7.4 ladder — it may predate this driver's session — and is
 * driver-less when the ladder says unidentified. Other stored events keep `driverId` null: they
 * are device telemetry, joined to drivers by `vehicleId` + time when needed.
 */
@Injectable()
export class DeviceEventsService {
  private readonly logger = new Logger(DeviceEventsService.name);

  constructor(
    private readonly ingest: IngestService,
    private readonly repo: IngestRepository,
    private readonly events: EventBusService,
    @InjectQueue(QUEUES.ALERT) private readonly alertQueue: Queue,
  ) {}

  async ingestDeviceEvents(dto: IngestDeviceEventsDto, driverId: string): Promise<DeviceEventsResult> {
    const ctx = await this.ingest.resolveContext(dto.deviceSerial, driverId, dto.vehicleId);
    const now = new Date();

    // In-payload dedupe on the ACK key; the DB unique index handles cross-batch replays.
    const unique = new Map<string, DeviceRawEventDto>();
    for (const event of dto.events) unique.set(rawEventKey(event), event);
    const ordered = [...unique.values()].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

    const outcome = await this.repo.runInTransaction(async (tx) => {
      const pcActive = await this.repo.findPcStateBefore(tx, driverId, ordered[0].occurredAt);

      const rows: Prisma.DeviceRawEventCreateManyInput[] = [];
      for (const event of ordered) {
        let owner: string | null = event.live ? driverId : null;
        if (!event.live && isHarshType(event.type)) {
          const window = await this.repo.findSessionWindow(tx, ctx.vehicle.id, event.occurredAt);
          owner = resolveStoredEventOwner(event.occurredAt, window).driverId;
        }
        rows.push(
          toRawEventRow(event, { deviceId: ctx.device.id, vehicleId: ctx.vehicle.id, driverId: owner, pcActive }),
        );
      }

      const inserted = await this.repo.insertDeviceRawEvents(tx, rows);
      const insertedKeys = new Set(inserted.map((r) => rawEventKey(r)));

      const safetyRows = rows
        .filter((row) => insertedKeys.has(rawEventKey({ occurredAt: row.occurredAt as Date, seq: row.seq })))
        .map((row) => toSafetyEventRow(row, ctx.device))
        .filter((row): row is Prisma.SafetyEventCreateManyInput => row !== null);
      await this.repo.insertSafetyEvents(tx, safetyRows);

      // `lastEventAt` only moves forward — stored events arrive hours late.
      const newest = ordered[ordered.length - 1].occurredAt;
      const lastEventAt =
        ctx.device.lastEventAt && ctx.device.lastEventAt.getTime() > newest.getTime() ? ctx.device.lastEventAt : newest;
      await this.repo.updateDevice(tx, ctx.device.id, { lastSeenAt: now, lastEventAt });

      return { stored: inserted.length, safetyRows };
    });

    // After commit — same fan-out as the worker's telemetry-based harsh detection.
    for (const row of outcome.safetyRows) {
      await this.events.publish('realtime.push', {
        room: 'fleet',
        event: 'safety.event_created',
        payload: { vehicleId: ctx.vehicle.id, driverId: row.driverId ?? null, type: row.type, severity: row.severity },
      });
      await this.alertQueue
        .add('alert.harsh_event', {
          vehicleId: ctx.vehicle.id,
          driverId: row.driverId ?? null,
          type: row.type,
          severity: row.severity,
        })
        .catch((err: unknown) => this.logger.error({ err }, 'Failed to enqueue alert.harsh_event'));
    }

    return {
      received: dto.events.length,
      stored: outcome.stored,
      duplicates: dto.events.length - outcome.stored,
      safetyEvents: outcome.safetyRows.length,
    };
  }
}
