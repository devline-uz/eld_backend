import { Injectable, Logger } from '@nestjs/common';
import type { DiagnosticTroubleCode } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { BusType } from '@prisma/client';
import type { DtcCodeDto, TelemetryPointDto } from '../ingest/dto/ingest.dto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { DtcRepository } from './dtc.repository';

/**
 * TZ §5.7 — DTC capture from the ingest path. `POST /ingest/telemetry` points optionally carry
 * a per-code breakdown behind `dtcCount` (SPN/FMI); this service turns that stream into
 * `DiagnosticTroubleCode` rows:
 *  - a dedupe key (J1939 spn+fmi, J1708 SID/PID+fmi, OBD-II code — see `normaliseDtc`) with no
 *    currently-OPEN row is a new code (`firstSeenAt`);
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
            await this.upsertCode(vehicleId, normaliseDtc(code, point.busType ?? null), point.milOn ?? null, point.time);
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

  private async upsertCode(vehicleId: string, dtc: NormalisedDtc, milOn: boolean | null, at: Date): Promise<void> {
    const existing = await this.repo.findOpenByCode(vehicleId, dtc.key);
    if (existing) {
      const lastSeenAt = existing.lastSeenAt && existing.lastSeenAt > at ? existing.lastSeenAt : at;
      await this.repo.bumpOccurrence(existing.id, lastSeenAt, {
        ...(dtc.occurrence !== null && { occurrence: Math.max(existing.occurrence ?? 0, dtc.occurrence) }),
        ...(dtc.bus !== null && { bus: dtc.bus }),
        ...(milOn !== null && { milOn }),
        ...(dtc.active !== null && { active: dtc.active }),
        ...(dtc.conversionMethod !== null && { conversionMethod: dtc.conversionMethod }),
      });
      return;
    }
    const data: Prisma.DiagnosticTroubleCodeCreateInput = {
      vehicleId,
      spn: dtc.key.spn,
      fmi: dtc.key.fmi,
      code: dtc.key.code,
      bus: dtc.bus,
      milOn,
      active: dtc.active,
      conversionMethod: dtc.conversionMethod,
      source: dtc.source,
      description: dtc.description,
      firstSeenAt: at,
      lastSeenAt: at,
      occurrence: dtc.occurrence && dtc.occurrence > 0 ? dtc.occurrence : 1,
    };
    await this.repo.create(data);
  }
}

export interface NormalisedDtc {
  /** Dedupe key: J1939 (spn, fmi); J1708 (code `SID n`/`PID n`, fmi); OBD-II (code). */
  key: { spn: number | null; fmi: number | null; code: string | null };
  bus: BusType | null;
  occurrence: number | null;
  active: boolean | null;
  conversionMethod: number | null;
  source: string | null;
  description: string | null;
}

/**
 * SDK 6.11 `DtcData` is bus-specific; one table holds all three shapes, so the dedupe key is
 * normalised per bus (D-135):
 *  - J1939: (spn, fmi), `code` null;
 *  - J1708: (`SID n` | `PID n`, fmi), `spn` null — the SID/PID number arrives in `spn` + `isSid`
 *    when the app does not pre-format `code`;
 *  - OBD-II: upper-cased `code` (`P0301`) only.
 * The fault's own `bus` wins over the point's `busType`; with neither, a `code` without an SPN
 * reads as OBD-II and anything else as J1939 (the pre-6.11 payload shape).
 */
export function normaliseDtc(code: DtcCodeDto, pointBus: BusType | null): NormalisedDtc {
  const text = code.code?.trim().toUpperCase() || null;
  const spn = code.spn ?? null;
  const fmi = code.fmi ?? null;
  const bus: BusType | null =
    code.bus ?? pointBus ?? (text && spn === null ? 'OBD_II' : spn !== null ? 'J1939' : null);
  const base = {
    bus,
    occurrence: code.occurrence ?? null,
    active: code.active ?? null,
    conversionMethod: code.conversionMethod ?? null,
    source: code.source ?? null,
    description: code.description ?? null,
  };
  if (bus === 'J1708') {
    const label = text ?? (spn !== null ? `${code.isSid ? 'SID' : 'PID'} ${spn}` : null);
    return { ...base, key: { spn: null, fmi, code: label } };
  }
  if (bus === 'OBD_II') {
    return { ...base, key: { spn: null, fmi: null, code: text } };
  }
  return { ...base, key: { spn, fmi, code: spn === null ? text : null } };
}

/** Thrown by callers that need a strict vehicle check before listing DTCs (kept out of the
 *  service itself so a future caller can decide whether a missing vehicle is a 404). */
export function assertVehicleFound(vehicle: unknown, vehicleId: string): void {
  if (!vehicle) throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404, { vehicleId });
}
