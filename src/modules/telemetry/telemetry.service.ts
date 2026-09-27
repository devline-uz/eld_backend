import { Injectable } from '@nestjs/common';
import type { TelemetryPoint } from '@prisma/client';
import type { TelemetryPointDto } from '../ingest/dto/ingest.dto';
import { DtcService } from '../dtc/dtc.service';
import { TelemetryContext, inspectDownsampling, toTelemetryRow } from './telemetry.mapper';
import { TelemetryRepository } from './telemetry.repository';

export interface TelemetryWriteResult {
  accepted: number;
  duplicates: number;
  /** §7.5 — points that arrived denser than 1/60 s without being transitions. */
  denserThanContract: number;
}

/** TZ §5.6 / §7.5 — Virtual Dashboard write path, used by `/ingest/telemetry`. */
@Injectable()
export class TelemetryService {
  constructor(private readonly repo: TelemetryRepository, private readonly dtc: DtcService) {}

  async store(points: TelemetryPointDto[], ctx: TelemetryContext): Promise<TelemetryWriteResult> {
    const { kept, dense } = inspectDownsampling(points);
    const rows = kept.map((point) => toTelemetryRow(point, ctx));

    const months = [...new Set(rows.map((r) => monthStart(r.time)))];
    await this.repo.ensurePartitions(months);

    const accepted = await this.repo.insertMany(rows);
    // TZ §5.7 — DTC capture rides on the telemetry write path; never blocks it (see DtcService).
    await this.dtc.captureFromPoints(ctx.vehicleId, kept);
    return { accepted, duplicates: rows.length - accepted, denserThanContract: dense };
  }

  latest(vehicleId: string): Promise<TelemetryPoint | null> {
    return this.repo.latestForVehicle(vehicleId);
  }

  range(vehicleId: string, from: Date, to: Date): Promise<TelemetryPoint[]> {
    return this.repo.listRange(vehicleId, from, to);
  }

  recent(vehicleId: string, limit: number, from?: Date, to?: Date): Promise<TelemetryPoint[]> {
    return this.repo.listRecent(vehicleId, limit, from, to);
  }
}

function monthStart(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
