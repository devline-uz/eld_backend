import { Injectable, Logger } from '@nestjs/common';
import type { DiagnosticTroubleCode } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { TelemetryPointDto } from '../ingest/dto/ingest.dto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { DtcRepository } from './dtc.repository';

/**
 * TZ §5.7 — DTC capture from the ingest path. `POST /ingest/telemetry` points optionally carry
 * a per-code breakdown behind `dtcCount` (SPN/FMI); this service turns that stream into
 * `DiagnosticTroubleCode` rows:
 *  - a (vehicleId, spn, fmi) pair with no currently-OPEN row is a new code (`firstSeenAt`);
 *  - a repeat bumps `occurrence`/`lastSeenAt` instead of duplicating rows;
 *  - a point that reports `dtcCount: 0` (ECU says "no active codes") clears every currently
 *    OPEN code for that vehicle as of that point's time — the device does not tell us which
 *    code cleared, only that none remain active.
 *
 * D-0xx (decisions.md) — the ingest DTO only carries `dtcCount` per TZ §5.6; `dtcCodes` was
 * added as an optional, additive field so a PT30/SDK build that only reports the count keeps
 * working unchanged.
 */
@Injectable()
export class DtcService {
  private readonly logger = new Logger(DtcService.name);

  constructor(private readonly repo: DtcRepository) {}

  async captureFromPoints(vehicleId: string, points: TelemetryPointDto[]): Promise<void> {
    const ordered = [...points].sort((a, b) => a.time.getTime() - b.time.getTime());
    for (const point of ordered) {
      try {
        if (point.dtcCodes?.length) {
          for (const code of point.dtcCodes) {
            await this.upsertCode(vehicleId, code.spn ?? null, code.fmi ?? null, code.source ?? null, code.description ?? null, point.time);
          }
        } else if (point.dtcCount === 0) {
          await this.repo.clearAllOpen(vehicleId, point.time);
        }
      } catch (err) {
        // DTC capture must never fail the telemetry write it rides on.
        this.logger.error({ err, vehicleId }, 'Failed to capture a DTC point');
      }
    }
  }

  list(vehicleId: string, includeCleared: boolean): Promise<DiagnosticTroubleCode[]> {
    return this.repo.listForVehicle(vehicleId, includeCleared);
  }

  private async upsertCode(
    vehicleId: string,
    spn: number | null,
    fmi: number | null,
    source: string | null,
    description: string | null,
    at: Date,
  ): Promise<void> {
    const existing = await this.repo.findOpenByCode(vehicleId, spn, fmi);
    if (existing) {
      await this.repo.bumpOccurrence(existing.id, at);
      return;
    }
    const data: Prisma.DiagnosticTroubleCodeCreateInput = {
      vehicleId,
      spn,
      fmi,
      source,
      description,
      firstSeenAt: at,
      lastSeenAt: at,
      occurrence: 1,
    };
    await this.repo.create(data);
  }
}

/** Thrown by callers that need a strict vehicle check before listing DTCs (kept out of the
 *  service itself so a future caller can decide whether a missing vehicle is a 404). */
export function assertVehicleFound(vehicle: unknown, vehicleId: string): void {
  if (!vehicle) throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404, { vehicleId });
}
