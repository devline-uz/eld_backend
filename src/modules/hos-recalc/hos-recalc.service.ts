import { Injectable, Logger } from '@nestjs/common';
import { computeHos } from '../hos/engine/compute-hos';
import { addDays, dayEnd, dayKey, dayStart } from '../hos/engine/timezone';
import { mapEldEventsToNormalized } from '../hos/hos-event-mapper';
import { reconcileViolations, type ExistingViolation } from '../hos/hos-violation-plan';
import { HOS_ENGINE_VERSION } from '../hos/hos.constants';
import type { HosState, PreviousDay } from '../hos/hos.types';
import { buildDailyLogHeaders, RODS_HEADER_LOOKBACK_DAYS } from '../logs/daily-log-header';
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

/**
 * B-055 — drivers per batched read. Together with the per-driver cap this bounds one chunk to
 * at most 25 × 2 001 slim rows, whatever the fleet or `EldEvent` table size.
 */
export const HOS_BATCH_CHUNK_SIZE = 25;

/**
 * B-055 — duty-status + PC/YM records a single driver may have inside one ~10-day window before
 * the batch refuses to compute it. 2 000 is ~200 records a day; real RODS logs a few dozen.
 */
export const HOS_BATCH_MAX_EVENTS_PER_DRIVER = 2000;

function groupByDriver<T extends { driverId: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const list = grouped.get(row.driverId);
    if (list) list.push(row);
    else grouped.set(row.driverId, [row]);
  }
  return grouped;
}

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

    // B-059 — the day headers first: the engine reads the day before `firstKey` as recap
    // history, and a header built while that day was still running would otherwise stay partial.
    await this.rebuildHeaders(driver.id, timezone, addDays(firstKey, -1), todayKey, now);

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
   * B-059 — rebuilds the `DailyLog` totals of `[fromKey, toKey ?? today]` from the stored records
   * through the shared `buildDailyLogHeaders` (the builder `GET /logs` uses). Certification is
   * never written. Returns the number of headers upserted; 0 for an unknown driver.
   */
  async rebuildDailyLogs(driverId: string, fromKey: string, now: Date = new Date(), toKey?: string): Promise<number> {
    const driver = await this.repo.findDriver(driverId);
    if (!driver) return 0;
    const timezone = driver.homeTerminalTimezone;
    const todayKey = dayKey(timezone, now);
    const last = toKey && toKey < todayKey ? toKey : todayKey;
    if (fromKey > last) return 0;
    return this.rebuildHeaders(driver.id, timezone, fromKey, last, now);
  }

  private async rebuildHeaders(driverId: string, timezone: string, fromKey: string, toKey: string, now: Date): Promise<number> {
    const windowStart = dayStart(timezone, addDays(fromKey, -RODS_HEADER_LOOKBACK_DAYS));
    const windowEnd = new Date(Math.min(dayEnd(timezone, toKey).getTime(), now.getTime()));
    const events = await this.repo.findRodsEvents(driverId, windowStart, windowEnd);
    const vehicleIds = [...new Set(events.map((event) => event.vehicleId).filter((id): id is string => Boolean(id)))];
    const segments = await this.repo.findUnidentifiedSegments(vehicleIds, dayStart(timezone, fromKey), windowEnd);
    const stored = await this.repo.findDailyLogs(driverId, utcDate(fromKey), utcDate(toKey));
    const previousHasEdits = new Map(stored.map((row) => [dayKey('UTC', row.logDate), row.hasEdits]));

    const built = buildDailyLogHeaders({ events, timezone, fromKey, toKey, now, segments, previousHasEdits });
    for (const { header } of built) {
      const { logDate, ...totals } = header;
      await this.repo.upsertDailyLogTotals({ driverId, logDate: utcDate(logDate), ...totals });
    }
    return built.length;
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
    return this.runEngine(driver, timezone, firstKey, now, events, dailyLogs);
  }

  /**
   * Batched READ-ONLY `computeCurrentState` for many drivers (`GET /drivers/roster`,
   * `GET /live/fleet`). B-055: each driver is read with ITS OWN window — exactly the one
   * `computeState` loads for it alone (home-terminal day boundary, `RECALC_LOOKBACK_DAYS`) —
   * so the engine input, and therefore the result, is identical to the single-driver path.
   *
   * Memory is bounded twice: drivers are processed `HOS_BATCH_CHUNK_SIZE` at a time, and each
   * driver's read is capped at `HOS_BATCH_MAX_EVENTS_PER_DRIVER`. A driver whose window holds
   * more rows than that is never computed from a truncated history: it is logged at error
   * level and left out of the map, which every caller already treats as "clocks unavailable".
   */
  async computeCurrentStates(drivers: DriverHosRow[], now: Date = new Date()): Promise<Map<string, HosState>> {
    const result = new Map<string, HosState>();
    for (let offset = 0; offset < drivers.length; offset += HOS_BATCH_CHUNK_SIZE) {
      await this.computeChunk(drivers.slice(offset, offset + HOS_BATCH_CHUNK_SIZE), now, result);
    }
    return result;
  }

  private async computeChunk(drivers: DriverHosRow[], now: Date, result: Map<string, HosState>): Promise<void> {
    const windows = drivers.map((driver) => {
      const timezone = driver.homeTerminalTimezone;
      const firstKey = dayKey(timezone, now);
      const historyKey = addDays(firstKey, -RECALC_LOOKBACK_DAYS);
      return { driver, timezone, firstKey, eventsFrom: dayStart(timezone, historyKey), logsFrom: utcDate(historyKey), logsTo: utcDate(firstKey) };
    });
    const ids = drivers.map((driver) => driver.id);
    // DailyLog is unique per (driverId, logDate): the widest span across zones is ~11 rows each.
    const minTime = (dates: Date[]): Date => new Date(Math.min(...dates.map((d) => d.getTime())));
    const maxTime = (dates: Date[]): Date => new Date(Math.max(...dates.map((d) => d.getTime())));

    const [events, dailyLogs] = await Promise.all([
      this.repo.findEventsForDrivers(
        windows.map((w) => ({ driverId: w.driver.id, from: w.eventsFrom })),
        now,
        HOS_BATCH_MAX_EVENTS_PER_DRIVER + 1,
      ),
      this.repo.findDailyLogsForDrivers(ids, minTime(windows.map((w) => w.logsFrom)), maxTime(windows.map((w) => w.logsTo))),
    ]);

    const eventsByDriver = groupByDriver(events);
    const logsByDriver = groupByDriver(dailyLogs);
    for (const w of windows) {
      const ownEvents = (eventsByDriver.get(w.driver.id) ?? []).filter((e) => e.eventDateTime.getTime() >= w.eventsFrom.getTime());
      if (ownEvents.length > HOS_BATCH_MAX_EVENTS_PER_DRIVER) {
        this.logger.error(
          { driverId: w.driver.id, from: w.eventsFrom.toISOString(), cap: HOS_BATCH_MAX_EVENTS_PER_DRIVER },
          'hos batch: driver event window exceeds the per-driver cap — clocks omitted rather than computed from a truncated history',
        );
        continue;
      }
      const ownLogs = (logsByDriver.get(w.driver.id) ?? []).filter(
        (l) => l.logDate.getTime() >= w.logsFrom.getTime() && l.logDate.getTime() <= w.logsTo.getTime(),
      );
      result.set(w.driver.id, this.runEngine(w.driver, w.timezone, w.firstKey, now, ownEvents, ownLogs));
    }
  }

  /** The single place the engine input is assembled — shared by every read and write path. */
  private runEngine(
    driver: DriverHosRow,
    timezone: string,
    firstKey: string,
    now: Date,
    events: Parameters<typeof mapEldEventsToNormalized>[0],
    dailyLogs: Array<{ logDate: Date; onDutySec: number; drivingSec: number }>,
  ): HosState {
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
