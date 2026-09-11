import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { haversineMiles, jurisdictionFor } from '../lib/jurisdiction';
import { IftaSegmentsRepository } from './ifta-segments.repository';

/** TZ §15 warning box — IFTA audits reach back 4 years while telemetry is deleted after 13
 * months, so `IftaSegment` is computed every night while the raw points still exist, and once
 * a quarter closes its rows are locked (never recomputed even if telemetry were still around).
 * `LOCK_GRACE_DAYS` gives dispatch a short correction window after a quarter's last day before
 * the nightly job stops touching it — long enough to catch a late device sync, short enough
 * that "locked" still means something before the IFTA filing deadline (last day of month
 * following quarter end). */
export const LOCK_GRACE_DAYS = 20;

export interface IftaNightlyResult {
  date: string;
  vehiclesScanned: number;
  segmentsUpserted: number;
  segmentsLocked: number;
}

function quarterEnd(date: DateTime): DateTime {
  const q = Math.floor((date.month - 1) / 3);
  const endMonth = q * 3 + 3;
  return DateTime.utc(date.year, endMonth, 1).endOf('month').startOf('day');
}

@Injectable()
export class IftaSegmentsService {
  private readonly logger = new Logger(IftaSegmentsService.name);

  constructor(private readonly repo: IftaSegmentsRepository) {}

  /** Computes `IftaSegment` rows for every vehicle that had telemetry on `date` (UTC day).
   * Idempotent: re-running the same date re-derives and upserts the same totals, EXCEPT for
   * rows already `locked = true`, which are skipped untouched (§15). */
  async computeForDate(date: DateTime): Promise<IftaNightlyResult> {
    const dayStart = date.startOf('day').toJSDate();
    const dayEnd = date.endOf('day').toJSDate();
    const dbDate = date.startOf('day').toJSDate();

    const vehicleIds = await this.repo.distinctVehicleIdsWithTelemetry(dayStart, dayEnd);

    let segmentsUpserted = 0;
    for (const { vehicleId } of vehicleIds) {
      const already = await this.repo.existingSegments(vehicleId, dbDate);
      if (already.length && already.every((s) => s.locked)) continue; // whole day is locked

      const points = await this.repo.telemetryForVehicleDay(vehicleId, dayStart, dayEnd);
      if (points.length < 2) continue;

      const byJurisdiction = new Map<string, number>();
      let lastDriverId: string | null = null;
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const cur = points[i];
        lastDriverId = cur.driverId ?? lastDriverId;
        const lat = Number(cur.latitude);
        const lon = Number(cur.longitude);
        const jurisdiction = jurisdictionFor(lat, lon);
        if (!jurisdiction) continue;

        let deltaMi: number;
        if (prev.odometerMi != null && cur.odometerMi != null && cur.odometerMi >= prev.odometerMi) {
          deltaMi = cur.odometerMi - prev.odometerMi;
        } else {
          deltaMi = haversineMiles(Number(prev.latitude), Number(prev.longitude), lat, lon);
        }
        if (deltaMi <= 0 || deltaMi > 200) continue; // guard against GPS jitter/odometer resets

        byJurisdiction.set(jurisdiction, (byJurisdiction.get(jurisdiction) ?? 0) + deltaMi);
      }

      for (const [jurisdiction, miles] of byJurisdiction) {
        const existing = already.find((s) => s.jurisdiction === jurisdiction);
        if (existing?.locked) continue;
        await this.repo.upsertSegment(vehicleId, jurisdiction, dbDate, lastDriverId, Math.round(miles));
        segmentsUpserted += 1;
      }
    }

    const segmentsLocked = await this.lockClosedQuarters(date);
    const result: IftaNightlyResult = {
      date: date.toISODate() ?? '',
      vehiclesScanned: vehicleIds.length,
      segmentsUpserted,
      segmentsLocked,
    };
    this.logger.log(result, 'ifta-nightly segments computed');
    return result;
  }

  /** Locks every unlocked `IftaSegment` whose quarter ended more than `LOCK_GRACE_DAYS` ago,
   * relative to `now`. Never touches a row already locked (§15 "qayta hisoblanmaydi"). */
  private async lockClosedQuarters(now: DateTime): Promise<number> {
    // Walk back one quarter at a time until the grace window no longer applies — bounded to
    // avoid an unbounded scan on a cold/never-run environment.
    let locked = 0;
    for (let back = 0; back < 20; back++) {
      const probe = now.minus({ months: back * 3 });
      const qEnd = quarterEnd(probe);
      if (now.diff(qEnd, 'days').days < LOCK_GRACE_DAYS) continue;
      const qStart = qEnd.minus({ months: 2 }).startOf('month');
      const count = await this.repo.lockQuarter(qStart.toJSDate(), qEnd.toJSDate());
      locked += count;
      // Once we reach a quarter with zero unlocked rows AND it is far enough back, further
      // quarters have already been locked by previous nightly runs — stop scanning.
      if (count === 0 && back > 4) break;
    }
    return locked;
  }
}
