import { Injectable } from '@nestjs/common';
import type { Device, EldEvent, Prisma, Vehicle } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AUTO_CHECK_WINDOW_SEC } from './detectors';
import { EVENT_SEQUENCE_MIN, EVENT_TYPE, LOGIN_CODE, PC_YM_CODE, nextSequenceId } from './event-codes';
import type { UnitSessionWindow } from './ownership';

/** Opaque transaction handle — the service passes it around but never calls Prisma on it. */
export type IngestTx = Prisma.TransactionClient;

/** Gap longer than this between two samples counts as "no data" for §7.8 `E` / `L`. */
const SAMPLE_GAP_TOLERANCE_SEC = 300;

export interface WindowStats {
  powerOffSec: number;
  ecmSilenceSec: number;
  noPositionSec: number;
  unidentifiedDrivingSec: number;
  powerDataMissing: boolean;
}

/**
 * TZ §3.5 — every DB call for ingest lives here. `EldEvent` is append-only (§5.5): this
 * repository deliberately exposes no update/delete path for it.
 */
@Injectable()
export class IngestRepository extends BaseRepository<
  EldEvent,
  Prisma.EldEventWhereInput,
  Prisma.EldEventWhereUniqueInput,
  Prisma.EldEventCreateInput,
  Prisma.EldEventUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    EldEvent,
    Prisma.EldEventWhereInput,
    Prisma.EldEventWhereUniqueInput,
    Prisma.EldEventCreateInput,
    Prisma.EldEventUpdateInput
  > {
    return this.prisma.eldEvent;
  }

  /** §7.3 rule 6 — the whole batch commits in ONE transaction. */
  runInTransaction<T>(fn: (tx: IngestTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, { timeout: 30_000, maxWait: 10_000 });
  }

  // --- lookups used to verify the untrusted payload ------------------------

  findDeviceBySerial(serial: string): Promise<Device | null> {
    return this.prisma.device.findUnique({ where: { serial } });
  }

  findVehicle(id: string): Promise<Vehicle | null> {
    return this.prisma.vehicle.findUnique({ where: { id } });
  }

  /** The driver's own claim to this unit: their assignment, checked before attribution. */
  async findDriverAssignedVehicleId(driverId: string): Promise<string | null | undefined> {
    const driver = await this.prisma.driver.findUnique({
      where: { id: driverId },
      select: { assignedVehicleId: true },
    });
    return driver?.assignedVehicleId;
  }

  /** A driver with an open (not logged-out) session on this unit may post for it too. */
  async hasOpenSessionOnVehicle(driverId: string, vehicleId: string, at: Date): Promise<boolean> {
    const last = await this.prisma.eldEvent.findFirst({
      where: {
        vehicleId,
        driverId,
        eventType: EVENT_TYPE.LOGIN_LOGOUT,
        eventDateTime: { lte: at },
      },
      orderBy: [{ eventDateTime: 'desc' }, { id: 'desc' }],
      select: { eventCode: true },
    });
    return last?.eventCode === LOGIN_CODE.LOGIN;
  }

  // --- idempotency ---------------------------------------------------------

  /** §7.3 rule 1 — duplicates by `uuid` are dropped, the response still says 200 OK. */
  async findExistingUuids(tx: IngestTx, uuids: string[]): Promise<Set<string>> {
    if (!uuids.length) return new Set();
    const rows = await tx.eldEvent.findMany({ where: { uuid: { in: uuids } }, select: { uuid: true } });
    return new Set(rows.map((r) => r.uuid));
  }

  // --- event sequence (§5.5 / §7.3 rule 8) ---------------------------------

  /**
   * Allocates `count` consecutive sequence numbers for one key (driverId, or
   * `unidentified:<vehicleId>`), under a transaction-scoped advisory lock so two concurrent
   * batches for the same driver can never hand out the same number. Assigned ONCE, here.
   */
  async allocateSequenceIds(tx: IngestTx, key: string, count: number): Promise<number[]> {
    if (count <= 0) return [];
    // `$executeRawUnsafe`, not `$queryRaw`: pg_advisory_xact_lock() returns void and Prisma
    // cannot deserialize a void column.
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, `eldseq:${key}`);

    const existing = await tx.eventSequenceCounter.findUnique({ where: { key } });
    let last = existing?.lastSequenceId ?? 0;

    if (!existing) {
      // First allocation for this key: continue from whatever the append-only table already
      // holds (events may predate this counter, e.g. seeded/imported data).
      const previous = await this.lastSequenceFromEvents(tx, key);
      last = previous ?? 0;
    }

    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) {
      last = last === 0 ? EVENT_SEQUENCE_MIN : nextSequenceId(last);
      ids.push(last);
    }

    await tx.eventSequenceCounter.upsert({
      where: { key },
      create: { key, lastSequenceId: last },
      update: { lastSequenceId: last },
    });
    return ids;
  }

  private async lastSequenceFromEvents(tx: IngestTx, key: string): Promise<number | null> {
    const driverId = key.startsWith('unidentified:') ? null : key;
    const vehicleId = key.startsWith('unidentified:') ? key.slice('unidentified:'.length) : undefined;
    const row = await tx.eldEvent.findFirst({
      where: driverId ? { driverId } : { driverId: null, vehicleId },
      orderBy: [{ eventDateTime: 'desc' }, { id: 'desc' }],
      select: { eventSequenceId: true },
    });
    return row?.eventSequenceId ?? null;
  }

  // --- partitions (§5.5) ---------------------------------------------------

  /**
   * Events arrive late (§7.3 rule 3 — up to 30 days of device memory), so the month they
   * belong to may not have a partition yet. No-op when it exists; never throws.
   */
  async ensurePartitions(tx: IngestTx, months: string[]): Promise<void> {
    for (const month of months) {
      await tx.$executeRawUnsafe(`SELECT ensure_event_partition($1::date)`, month);
    }
  }

  // --- writes --------------------------------------------------------------

  async insertEvents(tx: IngestTx, rows: Prisma.EldEventCreateManyInput[]): Promise<number> {
    if (!rows.length) return 0;
    const result = await tx.eldEvent.createMany({ data: rows, skipDuplicates: true });
    return result.count;
  }

  /** Ids of just-inserted events, by uuid — needed for `UnidentifiedSegment.eventIds`. */
  async findEventIdsByUuids(tx: IngestTx, uuids: string[]): Promise<bigint[]> {
    if (!uuids.length) return [];
    const rows = await tx.eldEvent.findMany({ where: { uuid: { in: uuids } }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  createUnidentifiedSegment(
    tx: IngestTx,
    data: Prisma.UnidentifiedSegmentCreateInput,
  ): Promise<{ id: string }> {
    return tx.unidentifiedSegment.create({ data, select: { id: true } });
  }

  updateVehicle(tx: IngestTx, id: string, data: Prisma.VehicleUpdateInput): Promise<Vehicle> {
    return tx.vehicle.update({ where: { id }, data });
  }

  updateDevice(tx: IngestTx, id: string, data: Prisma.DeviceUpdateInput): Promise<Device> {
    return tx.device.update({ where: { id }, data });
  }

  updateDeviceOutsideTx(id: string, data: Prisma.DeviceUpdateInput): Promise<Device> {
    return this.prisma.device.update({ where: { id }, data });
  }

  // --- state needed by the ingest rules ------------------------------------

  /** §7.3 rule 9 — is Personal Conveyance active for this driver at `at`? */
  async findPcStateBefore(tx: IngestTx, driverId: string, at: Date): Promise<boolean> {
    const last = await tx.eldEvent.findFirst({
      where: { driverId, eventType: EVENT_TYPE.PC_YM_INDICATION, eventDateTime: { lte: at } },
      orderBy: [{ eventDateTime: 'desc' }, { id: 'desc' }],
      select: { eventCode: true },
    });
    return last?.eventCode === PC_YM_CODE.PC;
  }

  /** §7.4 — the session picture around a device-stored event, for the ownership ladder. */
  async findSessionWindow(tx: IngestTx, vehicleId: string, at: Date): Promise<UnitSessionWindow> {
    const before = await tx.eldEvent.findFirst({
      where: { vehicleId, eventType: EVENT_TYPE.LOGIN_LOGOUT, eventDateTime: { lte: at } },
      orderBy: [{ eventDateTime: 'desc' }, { id: 'desc' }],
      select: { driverId: true, eventCode: true, eventDateTime: true },
    });
    const after = await tx.eldEvent.findFirst({
      where: {
        vehicleId,
        eventType: EVENT_TYPE.LOGIN_LOGOUT,
        eventCode: LOGIN_CODE.LOGIN,
        eventDateTime: { gt: at },
      },
      orderBy: [{ eventDateTime: 'asc' }, { id: 'asc' }],
      select: { driverId: true, eventDateTime: true },
    });

    return {
      openSessionDriverId:
        before?.eventCode === LOGIN_CODE.LOGIN && before.driverId ? before.driverId : null,
      lastBefore:
        before?.driverId && before.eventCode === LOGIN_CODE.LOGOUT
          ? { driverId: before.driverId, at: before.eventDateTime }
          : null,
      firstAfter: after?.driverId ? { driverId: after.driverId, at: after.eventDateTime } : null,
    };
  }

  /** Previous device odometer reading (§4.3 anomaly detection). */
  async findLastRawOdometerKm(tx: IngestTx, vehicleId: string, before: Date): Promise<number | null> {
    const row = await tx.eldEvent.findFirst({
      where: { vehicleId, rawDeviceOdometerKm: { not: null }, eventDateTime: { lt: before } },
      orderBy: [{ eventDateTime: 'desc' }, { id: 'desc' }],
      select: { rawDeviceOdometerKm: true },
    });
    return row?.rawDeviceOdometerKm ?? null;
  }

  // --- §7.8 windowed auto-checks ------------------------------------------

  /** Codes already logged in the window, so a malfunction is not re-recorded per batch. */
  async findLoggedCodesInWindow(vehicleId: string, since: Date): Promise<Set<string>> {
    const rows = await this.prisma.eldEvent.findMany({
      where: {
        vehicleId,
        eventType: EVENT_TYPE.MALFUNCTION_DIAGNOSTIC,
        eventDateTime: { gte: since },
      },
      select: { malfunctionCode: true, diagnosticCode: true },
    });
    const set = new Set<string>();
    for (const row of rows) {
      if (row.malfunctionCode) set.add(`M:${row.malfunctionCode}`);
      if (row.diagnosticCode) set.add(`D:${row.diagnosticCode}`);
    }
    return set;
  }

  /**
   * Gathers the raw numbers §7.8's 24-hour rules are evaluated over. Kept here (not in
   * `detectors.ts`) so the detectors stay pure and unit-testable.
   */
  async collectWindowStats(vehicleId: string, now: Date): Promise<WindowStats> {
    const since = new Date(now.getTime() - AUTO_CHECK_WINDOW_SEC * 1000);

    const [powerEvents, positionedEvents, ecmPoints, positionedPoints, segments] = await Promise.all([
      this.prisma.eldEvent.findMany({
        where: { vehicleId, eventType: EVENT_TYPE.ENGINE_POWER, eventDateTime: { gte: since } },
        orderBy: { eventDateTime: 'asc' },
        select: { eventCode: true, eventDateTime: true, totalEngineHours: true, rawDeviceOdometerKm: true },
      }),
      this.prisma.eldEvent.findMany({
        where: { vehicleId, eventDateTime: { gte: since }, latitude: { not: null } },
        orderBy: { eventDateTime: 'asc' },
        select: { eventDateTime: true },
      }),
      this.prisma.telemetryPoint.findMany({
        where: { vehicleId, time: { gte: since }, OR: [{ rpm: { not: null } }, { engineHours: { not: null } }] },
        orderBy: { time: 'asc' },
        select: { time: true },
      }),
      this.prisma.telemetryPoint.findMany({
        where: { vehicleId, time: { gte: since } },
        orderBy: { time: 'asc' },
        select: { time: true },
      }),
      this.prisma.unidentifiedSegment.findMany({
        where: { vehicleId, startAt: { gte: since } },
        select: { durationSec: true },
      }),
    ]);

    // §7.8 `P` — accumulate shutdown → next power-up spans.
    let powerOffSec = 0;
    let downSince: Date | null = null;
    for (const event of powerEvents) {
      const isShutdown = event.eventCode === 3 || event.eventCode === 4;
      if (isShutdown && !downSince) downSince = event.eventDateTime;
      if (!isShutdown && downSince) {
        powerOffSec += (event.eventDateTime.getTime() - downSince.getTime()) / 1000;
        downSince = null;
      }
    }
    if (downSince) powerOffSec += (now.getTime() - downSince.getTime()) / 1000;

    const ecmTimes = ecmPoints.map((p) => p.time);
    const positionTimes = [
      ...positionedEvents.map((e) => e.eventDateTime),
      ...positionedPoints.map((p) => p.time),
    ].sort((a, b) => a.getTime() - b.getTime());

    return {
      powerOffSec: Math.max(0, Math.round(powerOffSec)),
      ecmSilenceSec: gapSeconds(ecmTimes, since, now),
      noPositionSec: gapSeconds(positionTimes, since, now),
      unidentifiedDrivingSec: segments.reduce((sum, s) => sum + s.durationSec, 0),
      powerDataMissing: powerEvents.some(
        (e) => e.totalEngineHours === null && e.rawDeviceOdometerKm === null,
      ),
    };
  }
}

/**
 * Total seconds inside [`from`, `to`] not covered by a sample, counting only gaps longer than
 * the tolerance (a normal 30 s/60 s cadence must not look like an outage). An empty series
 * means the whole window is a gap.
 */
export function gapSeconds(samples: Date[], from: Date, to: Date): number {
  if (!samples.length) return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  let total = 0;
  let cursor = from.getTime();
  for (const sample of samples) {
    const gap = (sample.getTime() - cursor) / 1000;
    if (gap > SAMPLE_GAP_TOLERANCE_SEC) total += gap;
    cursor = Math.max(cursor, sample.getTime());
  }
  const tail = (to.getTime() - cursor) / 1000;
  if (tail > SAMPLE_GAP_TOLERANCE_SEC) total += tail;
  return Math.max(0, Math.round(total));
}
