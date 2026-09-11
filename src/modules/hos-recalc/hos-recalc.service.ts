import { Injectable, Logger } from '@nestjs/common';
import { computeHos } from '../hos/engine/compute-hos';
import { addDays, dayKey, dayStart } from '../hos/engine/timezone';
import { mapEldEventsToNormalized } from '../hos/hos-event-mapper';
import { reconcileViolations, type ExistingViolation } from '../hos/hos-violation-plan';
import { HOS_ENGINE_VERSION } from '../hos/hos.constants';
import type { HosState, PreviousDay } from '../hos/hos.types';
import { HosRecalcRepository } from './hos-recalc.repository';

/** The `Driver` columns the engine input is built from — everything else is irrelevant here. */
type DriverHosRow = NonNullable<Awaited<ReturnType<HosRecalcRepository['findDriver']>>>;

/** §8.4 — the job payload. `fromDate` is the §8.4 contract; `from` is what ingest enqueues. */
export interface HosRecalcJobData {
  driverId: string;
  fromDate?: string;
  from?: string;
  to?: string;
}

export interface HosRecalcResult {
  driverId: string;
  hosEngineVersion: string;
  days: string[];
  upserted: number;
  autoCleared: number;
  refreshed: number;
  state: HosState | null;
}

/**
 * Days of history pulled in BEFORE the first recalculated day. Eight days cover the 70/8
 * cycle, and the extra day guarantees the shift that was running at midnight is complete.
 */
export const RECALC_LOOKBACK_DAYS = 9;

/** "YYYY-MM-DD" → the UTC midnight Prisma uses for a `@db.Date` column. */
function utcDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

@Injectable()
export class HosRecalcService {
  private readonly logger = new Logger(HosRecalcService.name);

  constructor(private readonly repo: HosRecalcRepository) {}

  /**
   * §8.4 — recalculates FORWARD from `fromDate` to today and rewrites that range's violations.
   * Idempotent: the same events always produce the same rows, because every write is an upsert
   * on (driverId, logDate, type) and nothing is ever inserted blind.
   */
  async recalculate(data: HosRecalcJobData, now: Date = new Date()): Promise<HosRecalcResult> {
    const driver = await this.repo.findDriver(data.driverId);
    if (!driver) {
      this.logger.warn({ driverId: data.driverId }, 'hos.recalc for an unknown driver — skipped');
      return { driverId: data.driverId, hosEngineVersion: HOS_ENGINE_VERSION, days: [], upserted: 0, autoCleared: 0, refreshed: 0, state: null };
    }

    // §8 hard rule: the RODS day follows the driver's HOME TERMINAL, never Carrier.timezone.
    const timezone = driver.homeTerminalTimezone;
    const todayKey = dayKey(timezone, now);
    const firstKey = this.resolveFromKey(data, timezone, now, todayKey);
    const days = this.dayRange(firstKey, todayKey);

    const state = await this.computeState(driver, timezone, firstKey, now);

    const inScope = state.violations.filter((violation) => days.includes(violation.logDate));
    const existingRows = await this.repo.findViolations(driver.id, utcDate(firstKey), utcDate(todayKey));
    const existing: ExistingViolation[] = existingRows.map((row) => ({
      id: row.id,
      logDate: dayKey('UTC', row.logDate),
      type: row.type,
      status: row.status,
      exceededBySec: row.exceededBySec,
    }));

    const actions = reconcileViolations(inScope, existing, days);
    let upserted = 0;
    let autoCleared = 0;
    let refreshed = 0;

    for (const action of actions) {
      if (action.kind === 'UPSERT') {
        await this.repo.upsertViolation({
          driverId: driver.id,
          logDate: utcDate(action.logDate),
          type: action.type,
          occurredAt: action.occurredAt,
          exceededBySec: action.exceededBySec,
          detail: action.detail,
        });
        upserted += 1;
      } else if (action.kind === 'AUTO_CLEAR') {
        await this.repo.autoClear(action.id);
        autoCleared += 1;
      } else {
        await this.repo.refreshResolved(action.id, action.exceededBySec);
        refreshed += 1;
      }
    }

    for (const day of days) {
      const open = inScope.filter((violation) => violation.logDate === day).length;
      await this.repo.updateDailyLogViolationFlags(driver.id, utcDate(day), open);
    }

    this.logger.log({ driverId: driver.id, days: days.length, upserted, autoCleared, refreshed }, 'hos.recalc done');
    return { driverId: driver.id, hosEngineVersion: HOS_ENGINE_VERSION, days, upserted, autoCleared, refreshed, state };
  }

  /**
   * §8.6 point 5 — the READ-ONLY half of `recalculate()`: the driver's current HOS state as
   * the server computes it, with no violation writes. Used by `POST /mobile/hos-state` and by
   * the nightly drift sweep, which must never mutate anything just by looking.
   */
  async computeCurrentState(
    driverId: string,
    now: Date = new Date(),
  ): Promise<{ state: HosState; timezone: string } | null> {
    const driver = await this.repo.findDriver(driverId);
    if (!driver) return null;
    const timezone = driver.homeTerminalTimezone;
    const state = await this.computeState(driver, timezone, dayKey(timezone, now), now);
    return { state, timezone };
  }

  /**
   * Loads the history the engine needs and runs it. The engine itself stays pure — every read
   * happens here, nothing is written. `firstKey` is the first recalculated RODS day; history is
   * pulled from `RECALC_LOOKBACK_DAYS` before it so the 70/8 recap and the running shift are
   * both complete.
   */
  private async computeState(
    driver: DriverHosRow,
    timezone: string,
    firstKey: string,
    now: Date,
  ): Promise<HosState> {
    const historyKey = addDays(firstKey, -RECALC_LOOKBACK_DAYS);
    const events = await this.repo.findEvents(driver.id, dayStart(timezone, historyKey), now);
    // `DailyLog.logDate` and `HosViolation.logDate` are Postgres DATE columns: Prisma hands
    // them over as UTC midnight, so they are compared and read back in UTC, never in the
    // driver's zone — doing otherwise shifts every log date a day west.
    const dailyLogs = await this.repo.findDailyLogs(driver.id, utcDate(historyKey), utcDate(firstKey));

    const previousDays: PreviousDay[] = dailyLogs
      .map((log) => ({ date: dayKey('UTC', log.logDate), onDutySec: log.onDutySec + log.drivingSec }))
      .filter((day) => day.date < firstKey);

    return computeHos({
      events: mapEldEventsToNormalized(events),
      driver: {
        driverId: driver.id,
        allowPersonalConveyance: driver.allowPersonalConveyance,
        allowYardMove: driver.allowYardMove,
        adverseDrivingEnabled: driver.adverseDrivingEnabled,
        shortHaulException: driver.shortHaulException,
        splitSleeperEnabled: driver.splitSleeperEnabled,
      },
      ruleset: driver.hosRuleset,
      now,
      timezone,
      previousDays,
      lastRestartEndedAt: null,
    });
  }

  /** `fromDate` (a RODS day) wins; otherwise the ingest span's start; otherwise today. */
  private resolveFromKey(data: HosRecalcJobData, timezone: string, now: Date, todayKey: string): string {
    if (data.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(data.fromDate)) {
      return data.fromDate > todayKey ? todayKey : data.fromDate;
    }
    const source = data.fromDate ?? data.from;
    if (source) {
      const parsed = new Date(source);
      if (Number.isFinite(parsed.getTime())) {
        const key = dayKey(timezone, parsed.getTime() > now.getTime() ? now : parsed);
        return key > todayKey ? todayKey : key;
      }
    }
    return todayKey;
  }

  /** Every RODS day from `first` to `last`, capped so one job can never walk a whole year. */
  private dayRange(first: string, last: string): string[] {
    const days: string[] = [];
    let key = first;
    for (let guard = 0; guard < 400; guard += 1) {
      days.push(key);
      if (key >= last) break;
      key = addDays(key, 1);
    }
    return days;
  }
}
