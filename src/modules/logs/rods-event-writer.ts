import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { EditorType, Prisma } from '@prisma/client';
import { coarsenLocation } from '../../common/units';
import { offsetMs } from '../hos/engine/timezone';
import { computeChecksum } from '../ingest/checksum';
import { IngestRepository, IngestTx } from '../ingest/ingest.repository';
import type { AppendRow } from './edit-plan';

export interface AppendContext {
  /** `null` only when the record is written back to the unidentified pool (§7.4). */
  driverId: string | null;
  /** §5.5 — the per-driver sequence key, or `unidentified:<vehicleId>`. */
  sequenceKey: string;
  timezone: string;
  vehicleId?: string | null;
  deviceId?: string | null;
  editedById: string;
  editorType: EditorType;
  editReason?: string | null;
  /** B-39 — coordinates are optional: a carrier may correct a location by name only. */
  location?: { lat?: number | null; lon?: number | null; name?: string | null } | null;
  totalVehicleMiles?: number | null;
  /** B-72 — engine hours the proposer entered (Appendix A "total engine hours"). */
  totalEngineHours?: number | null;
  /** Personal Conveyance coarsens the stored position to 10 miles BEFORE the write (§23). */
  personalConveyance?: boolean;
  comment?: string | null;
}

/**
 * TZ §5.5 / §9 — the single place that APPENDS §395 records outside ingest.
 *
 * It reuses `IngestRepository` for the two things that must never be reimplemented: the
 * transaction-scoped `eventSequenceId` allocation (§7.3 rule 8 — assigned once, never
 * changed) and the monthly partition guard. Every row is checksummed exactly like a
 * device-recorded one, so `EldEvent.checksum` stays verifiable across the whole table (§23).
 */
@Injectable()
export class RodsEventWriter {
  constructor(private readonly ingest: IngestRepository) {}

  async append(tx: IngestTx, ctx: AppendContext, rows: AppendRow[]): Promise<Map<string, bigint>> {
    if (!rows.length) return new Map();

    // Sequence numbers are handed out in chronological order (§5.5), but the returned map is
    // keyed by the caller's own row order so `kind:index` always means what the caller meant.
    const ordered = rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => a.row.at.getTime() - b.row.at.getTime() || a.index - b.index);
    const sequenceIds = await this.ingest.allocateSequenceIds(tx, ctx.sequenceKey, ordered.length);
    await this.ingest.ensurePartitions(tx, uniqueMonths(rows.map((row) => row.at)));

    const uuidByKind = new Map<string, string>();
    const data: Prisma.EldEventCreateManyInput[] = ordered.map(({ row, index: originalIndex }, index) => {
      const uuid = randomUUID();
      uuidByKind.set(`${row.kind}:${originalIndex}`, uuid);
      const precisionMi = ctx.personalConveyance ? 10 : 1;
      const hasCoordinates =
        typeof ctx.location?.lat === 'number' && typeof ctx.location?.lon === 'number';
      const position = hasCoordinates
        ? coarsenLocation(
            { lat: ctx.location!.lat as number, lon: ctx.location!.lon as number },
            ctx.personalConveyance ? 'TEN_MILE' : 'ONE_MILE',
          )
        : null;
      const base = {
        uuid,
        eventType: row.eventType,
        eventCode: row.eventCode,
        eventDateTime: row.at,
        timezoneOffset: Math.round(offsetMs(ctx.timezone, row.at) / 60_000),
        recordStatus: row.recordStatus,
        recordOrigin: row.recordOrigin,
        latitude: position ? position.lat : null,
        longitude: position ? position.lon : null,
        rawDeviceOdometerKm: null,
        totalEngineHours: ctx.totalEngineHours ?? null,
      };
      return {
        ...base,
        driverId: ctx.driverId,
        vehicleId: ctx.vehicleId ?? null,
        deviceId: ctx.deviceId ?? null,
        eventSequenceId: sequenceIds[index],
        locationPrecisionMi: precisionMi,
        locationName: ctx.location?.name ?? null,
        totalVehicleMiles: ctx.totalVehicleMiles ?? null,
        annotation: row.annotation.slice(0, 60),
        comment: ctx.comment ?? null,
        supersedesId: row.supersedesId,
        editedById: ctx.editedById,
        editorType: ctx.editorType,
        editReason: ctx.editReason ?? null,
        checksum: computeChecksum(base),
      };
    });

    await this.ingest.insertEvents(tx, data);

    const ids = await tx.eldEvent.findMany({
      where: { uuid: { in: data.map((row) => row.uuid) } },
      select: { id: true, uuid: true },
    });
    const byUuid = new Map(ids.map((row) => [row.uuid, row.id]));

    const result = new Map<string, bigint>();
    rows.forEach((row, index) => {
      const uuid = uuidByKind.get(`${row.kind}:${index}`);
      const id = uuid ? byUuid.get(uuid) : undefined;
      if (id !== undefined) result.set(`${row.kind}:${index}`, id);
    });
    return result;
  }
}

function uniqueMonths(dates: Date[]): string[] {
  const months = new Set<string>();
  for (const date of dates) {
    months.add(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`);
  }
  return [...months];
}
