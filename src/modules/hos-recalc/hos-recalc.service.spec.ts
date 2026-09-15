/** TZ §8.4 — recalculation is idempotent and never duplicates a violation. */
import { HOS_BATCH_CHUNK_SIZE, HOS_BATCH_MAX_EVENTS_PER_DRIVER, HosRecalcService, RECALC_LOOKBACK_DAYS } from './hos-recalc.service';
import type { HosRecalcRepository } from './hos-recalc.repository';

const H = 3600;

interface FakeViolation {
  id: string;
  driverId: string;
  logDate: Date;
  type: string;
  occurredAt: Date;
  exceededBySec: number;
  detail: string;
  status: 'OPEN' | 'RESOLVED' | 'AUTO_CLEARED';
  recalcVersion: number;
}

class FakeRepo {
  driver: Record<string, unknown> | null = {
    id: 'driver-1',
    homeTerminalTimezone: 'America/New_York',
    hosRuleset: 'US_70_8_PROPERTY',
    allowPersonalConveyance: true,
    allowYardMove: true,
    adverseDrivingEnabled: false,
    shortHaulException: false,
    splitSleeperEnabled: true,
  };
  events: Array<{ eventType: number; eventCode: number; eventDateTime: Date; recordStatus: number; eventSequenceId: number }> = [];
  dailyLogs: Array<{ logDate: Date; onDutySec: number; drivingSec: number; hasEdits?: boolean }> = [];
  /** B-059 — every header totals write, in call order. */
  headerUpserts: Array<Record<string, unknown>> = [];
  segments: Array<{ status: string; startAt: Date; endAt: Date }> = [];
  violations: FakeViolation[] = [];
  dailyFlagUpdates: Array<{ logDate: string; count: number }> = [];

  findDriver = jest.fn(async () => this.driver);
  findEvents = jest.fn(async (_id: string, from: Date, to: Date) => this.events.filter((e) => e.eventDateTime >= from && e.eventDateTime <= to));
  findDailyLogs = jest.fn(async (_id: string, from: Date, to: Date) => this.dailyLogs.filter((l) => l.logDate >= from && l.logDate <= to));
  /** Batched reads: every fake row belongs to the fake driver, the rest are "other drivers". */
  otherDriverEvents: Array<{ driverId: string; eventType: number; eventCode: number; eventDateTime: Date; recordStatus: number; eventSequenceId: number }> = [];
  /** Mirrors the SQL: per-driver lower bound, active duty/PC-YM records only, LIMIT per driver. */
  findEventsForDrivers = jest.fn(async (windows: Array<{ driverId: string; from: Date }>, to: Date, limit: number) =>
    windows.flatMap((w) =>
      [...this.events.map((e) => ({ ...e, driverId: 'driver-1' })), ...this.otherDriverEvents]
        .filter((e) => e.driverId === w.driverId && e.recordStatus === 1 && (e.eventType === 1 || e.eventType === 3))
        .filter((e) => e.eventDateTime >= w.from && e.eventDateTime <= to)
        .sort((a, b) => a.eventDateTime.getTime() - b.eventDateTime.getTime() || a.eventSequenceId - b.eventSequenceId)
        .slice(0, limit),
    ),
  );
  findDailyLogsForDrivers = jest.fn(async (ids: string[], from: Date, to: Date) =>
    this.dailyLogs.map((l) => ({ ...l, driverId: 'driver-1' })).filter((l) => ids.includes(l.driverId) && l.logDate >= from && l.logDate <= to),
  );
  findViolations = jest.fn(async (_id: string, from: Date, to: Date) => this.violations.filter((v) => v.logDate >= from && v.logDate <= to));

  /** B-059 — every record status, with the RODS columns the fake events do not carry. */
  findRodsEvents = jest.fn(async (_id: string, from: Date, to: Date) =>
    this.events
      .filter((e) => e.eventDateTime >= from && e.eventDateTime <= to)
      .map((e) => ({ recordOrigin: 1, supersedesId: null, totalVehicleMiles: null, vehicleId: 'veh-1', ...e })),
  );
  findUnidentifiedSegments = jest.fn(async () => this.segments);
  upsertDailyLogTotals = jest.fn(async (args: { logDate: Date; onDutySec: number; drivingSec: number; hasEdits: boolean } & Record<string, unknown>) => {
    this.headerUpserts.push(args);
    const index = this.dailyLogs.findIndex((l) => l.logDate.getTime() === args.logDate.getTime());
    const row = { logDate: args.logDate, onDutySec: args.onDutySec, drivingSec: args.drivingSec, hasEdits: args.hasEdits };
    if (index >= 0) this.dailyLogs[index] = row;
    else this.dailyLogs.push(row);
    return row;
  });

  upsertViolation = jest.fn(async (args: { driverId: string; logDate: Date; type: string; occurredAt: Date; exceededBySec: number; detail: string }) => {
    const key = (v: FakeViolation): string => `${v.driverId}|${v.logDate.toISOString()}|${v.type}`;
    const wanted = `${args.driverId}|${args.logDate.toISOString()}|${args.type}`;
    const existing = this.violations.find((v) => key(v) === wanted);
    if (existing) {
      Object.assign(existing, { ...args, status: 'OPEN', recalcVersion: existing.recalcVersion + 1 });
      return existing;
    }
    const row: FakeViolation = { id: `v${this.violations.length + 1}`, status: 'OPEN', recalcVersion: 1, ...args } as unknown as FakeViolation;
    this.violations.push(row);
    return row;
  });

  autoClear = jest.fn(async (id: string) => {
    const row = this.violations.find((v) => v.id === id)!;
    row.status = 'AUTO_CLEARED';
    return row;
  });

  refreshResolved = jest.fn(async (id: string, exceededBySec: number) => {
    const row = this.violations.find((v) => v.id === id)!;
    row.exceededBySec = exceededBySec;
    return row;
  });

  updateDailyLogViolationFlags = jest.fn(async (_id: string, logDate: Date, count: number) => {
    this.dailyFlagUpdates.push({ logDate: logDate.toISOString().slice(0, 10), count });
    return 1;
  });
}

const duty = (iso: string, code: number, seq: number) => ({ eventType: 1, eventCode: code, eventDateTime: new Date(iso), recordStatus: 1, eventSequenceId: seq });

/** 10 h off, then 12 h of driving on 2025-01-14 — DRIVING_11 and BREAK_30 on one RODS day. */
const OVER_LIMIT_DAY = [duty('2025-01-14T05:00:00Z', 1, 1), duty('2025-01-14T15:00:00Z', 3, 2)];
const NOW = new Date('2025-01-15T03:00:00Z');

describe('HosRecalcService', () => {
  let repo: FakeRepo;
  let service: HosRecalcService;

  beforeEach(() => {
    repo = new FakeRepo();
    service = new HosRecalcService(repo as unknown as HosRecalcRepository);
  });

  it('skips an unknown driver without touching anything', async () => {
    repo.driver = null;
    const result = await service.recalculate({ driverId: 'ghost' }, NOW);
    expect(result.state).toBeNull();
    expect(repo.upsertViolation).not.toHaveBeenCalled();
  });

  it('returns the engine version so drift comparison can skip mismatched versions', async () => {
    const result = await service.recalculate({ driverId: 'driver-1' }, NOW);
    expect(result.hosEngineVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('writes the violations of the recalculated day', async () => {
    repo.events = OVER_LIMIT_DAY;
    const result = await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(result.upserted).toBe(2);
    expect(repo.violations.map((v) => v.type).sort()).toEqual(['BREAK_30', 'DRIVING_11']);
  });

  it('stores the violation log date at UTC midnight, as a Postgres DATE', async () => {
    repo.events = OVER_LIMIT_DAY;
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(repo.violations[0].logDate.toISOString()).toBe('2025-01-14T00:00:00.000Z');
  });

  it('never duplicates a violation across repeated runs', async () => {
    repo.events = OVER_LIMIT_DAY;
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(repo.violations).toHaveLength(2);
  });

  it('keeps the row id stable across recalculations', async () => {
    repo.events = OVER_LIMIT_DAY;
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    const ids = repo.violations.map((v) => v.id);
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(repo.violations.map((v) => v.id)).toEqual(ids);
  });

  it('auto-clears a violation that the fresh result no longer contains', async () => {
    repo.events = OVER_LIMIT_DAY;
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    repo.events = [duty('2025-01-14T05:00:00Z', 1, 1), duty('2025-01-14T15:00:00Z', 3, 2), duty('2025-01-14T20:00:00Z', 1, 3)];
    const result = await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(result.autoCleared).toBe(2);
    expect(repo.violations.every((v) => v.status === 'AUTO_CLEARED')).toBe(true);
  });

  it('never deletes an auto-cleared violation', async () => {
    repo.events = OVER_LIMIT_DAY;
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    repo.events = [];
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(repo.violations).toHaveLength(2);
  });

  it('reopens a violation that comes back', async () => {
    repo.events = OVER_LIMIT_DAY;
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    const clean = [duty('2025-01-14T05:00:00Z', 1, 1)];
    repo.events = clean;
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    repo.events = OVER_LIMIT_DAY;
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(repo.violations.every((v) => v.status === 'OPEN')).toBe(true);
  });

  it('never reopens a manually resolved violation', async () => {
    repo.events = OVER_LIMIT_DAY;
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    repo.violations.forEach((v) => { v.status = 'RESOLVED'; v.exceededBySec = 1; });
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(repo.violations.every((v) => v.status === 'RESOLVED')).toBe(true);
  });

  it('refreshes the magnitude of a resolved violation', async () => {
    repo.events = OVER_LIMIT_DAY;
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    repo.violations.forEach((v) => { v.status = 'RESOLVED'; v.exceededBySec = 1; });
    const result = await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(result.refreshed).toBe(2);
    expect(repo.violations.every((v) => v.exceededBySec > 1)).toBe(true);
  });

  it('does not touch a violation outside the recalculated range', async () => {
    repo.violations = [{ id: 'old', driverId: 'driver-1', logDate: new Date('2025-01-01T00:00:00Z'), type: 'SHIFT_14', occurredAt: NOW, exceededBySec: 60, detail: 'x', status: 'OPEN', recalcVersion: 1 }];
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(repo.violations[0].status).toBe('OPEN');
  });

  it('recalculates forward from the given date to today', async () => {
    const result = await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-12' }, NOW);
    expect(result.days).toEqual(['2025-01-12', '2025-01-13', '2025-01-14']);
  });

  it('defaults to today when no date is supplied', async () => {
    const result = await service.recalculate({ driverId: 'driver-1' }, NOW);
    expect(result.days).toEqual(['2025-01-14']);
  });

  it('accepts the ISO `from` span that ingest enqueues', async () => {
    const result = await service.recalculate({ driverId: 'driver-1', from: '2025-01-13T18:00:00Z' }, NOW);
    expect(result.days).toEqual(['2025-01-13', '2025-01-14']);
  });

  it('clamps a future fromDate to today', async () => {
    const result = await service.recalculate({ driverId: 'driver-1', fromDate: '2030-01-01' }, NOW);
    expect(result.days).toEqual(['2025-01-14']);
  });

  it('clamps a future ISO `from` to today', async () => {
    const result = await service.recalculate({ driverId: 'driver-1', from: '2030-01-01T00:00:00Z' }, NOW);
    expect(result.days).toEqual(['2025-01-14']);
  });

  it('falls back to today for an unparseable date', async () => {
    const result = await service.recalculate({ driverId: 'driver-1', from: 'not-a-date' }, NOW);
    expect(result.days).toEqual(['2025-01-14']);
  });

  it('reads history far enough back to cover the cycle', async () => {
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    const from = repo.findEvents.mock.calls[0][1];
    expect(from.toISOString()).toBe('2025-01-05T05:00:00.000Z');
    expect(RECALC_LOOKBACK_DAYS).toBe(9);
  });

  it('feeds DailyLog history into the cycle as previousDays', async () => {
    // 2025-01-12: before `firstKey - 1`, so this header is history and is not rebuilt (B-059).
    repo.dailyLogs = [{ logDate: new Date('2025-01-12T00:00:00Z'), onDutySec: 40 * H, drivingSec: 20 * H }];
    const result = await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(result.state?.cycleRemainingSec).toBe(10 * H);
  });

  it('ignores DailyLog rows inside the recalculated range — those are recomputed', async () => {
    repo.dailyLogs = [{ logDate: new Date('2025-01-14T00:00:00Z'), onDutySec: 60 * H, drivingSec: 0 }];
    const result = await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(result.state?.cycleRemainingSec).toBe(70 * H);
  });

  describe('B-059 — DailyLog headers are rebuilt from the records, not trusted', () => {
    it('rebuilds every header from the day before fromDate through today', async () => {
      await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-13' }, NOW);
      expect(repo.headerUpserts.map((h) => (h.logDate as Date).toISOString().slice(0, 10))).toEqual([
        '2025-01-12',
        '2025-01-13',
        '2025-01-14',
      ]);
    });

    it('rebuilds the headers BEFORE the engine reads the recap history', async () => {
      await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
      const upsertOrder = repo.upsertDailyLogTotals.mock.invocationCallOrder;
      const historyRead = repo.findDailyLogs.mock.invocationCallOrder[repo.findDailyLogs.mock.invocationCallOrder.length - 1];
      expect(Math.max(...upsertOrder)).toBeLessThan(historyRead);
    });

    it('replaces a stale previous-day header, so the recap uses the real on-duty time', async () => {
      // A stale header claims 60 h on 01-13; the records say the driver was off all day.
      repo.dailyLogs = [{ logDate: new Date('2025-01-13T00:00:00Z'), onDutySec: 60 * H, drivingSec: 0 }];
      repo.events = [duty('2025-01-10T05:00:00Z', 1, 1)];
      const result = await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
      expect(repo.dailyLogs.find((l) => l.logDate.toISOString().startsWith('2025-01-13'))).toMatchObject({ onDutySec: 0, drivingSec: 0 });
      expect(result.state?.cycleRemainingSec).toBe(70 * H);
    });

    it('counts on-duty time carried over midnight into the next day header', async () => {
      // ON from 01-12 20:00 EST until 01-13 02:00 EST: 01-13 carries 2 h of on-duty time.
      repo.events = [duty('2025-01-13T01:00:00Z', 4, 1), duty('2025-01-13T07:00:00Z', 1, 2)];
      await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
      const header = repo.headerUpserts.find((h) => (h.logDate as Date).toISOString().startsWith('2025-01-13'));
      expect(header).toMatchObject({ onDutySec: 2 * H, drivingSec: 0, offDutySec: 22 * H, timezone: 'America/New_York' });
    });

    it('writes totals only — never a certification column', async () => {
      repo.events = OVER_LIMIT_DAY;
      await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
      for (const header of repo.headerUpserts) {
        expect(Object.keys(header).sort()).toEqual(
          ['driverId', 'drivingSec', 'hasEdits', 'hasUnassigned', 'logDate', 'offDutySec', 'onDutySec', 'sleeperSec', 'timezone', 'totalDistanceMi'].sort(),
        );
      }
    });

    it('keeps hasEdits sticky once a day was edited', async () => {
      repo.dailyLogs = [{ logDate: new Date('2025-01-14T00:00:00Z'), onDutySec: 0, drivingSec: 0, hasEdits: true }];
      await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
      expect(repo.headerUpserts.find((h) => (h.logDate as Date).toISOString().startsWith('2025-01-14'))).toMatchObject({ hasEdits: true });
    });

    it('flags hasUnassigned from PENDING segments on the driver units only', async () => {
      repo.events = OVER_LIMIT_DAY;
      repo.segments = [
        { status: 'PENDING', startAt: new Date('2025-01-14T20:00:00Z'), endAt: new Date('2025-01-14T21:00:00Z') },
        { status: 'ASSIGNED', startAt: new Date('2025-01-13T20:00:00Z'), endAt: new Date('2025-01-13T21:00:00Z') },
      ];
      await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-13' }, NOW);
      const flag = (key: string) => repo.headerUpserts.find((h) => (h.logDate as Date).toISOString().startsWith(key))?.hasUnassigned;
      expect(flag('2025-01-14')).toBe(true);
      expect(flag('2025-01-13')).toBe(false);
      expect(repo.findUnidentifiedSegments).toHaveBeenCalledWith(['veh-1'], expect.any(Date), expect.any(Date));
    });

    it('never reads records past now for today', async () => {
      await service.recalculate({ driverId: 'driver-1' }, NOW);
      const to = repo.findRodsEvents.mock.calls[0][2];
      expect(to.getTime()).toBeLessThanOrEqual(NOW.getTime());
    });

    it('rebuildDailyLogs: 0 for an unknown driver, 0 for a future day, capped at today', async () => {
      expect(await service.rebuildDailyLogs('driver-1', '2025-01-20', NOW)).toBe(0);
      expect(await service.rebuildDailyLogs('driver-1', '2025-01-13', NOW, '2025-01-30')).toBe(2);
      expect(await service.rebuildDailyLogs('driver-1', '2025-01-12', NOW, '2025-01-12')).toBe(1);
      repo.driver = null;
      expect(await service.rebuildDailyLogs('ghost', '2025-01-13', NOW)).toBe(0);
    });

    it('the read-only paths never rebuild a header', async () => {
      await service.computeCurrentState('driver-1', NOW);
      await service.computeCurrentStates([repo.driver as never], NOW);
      expect(repo.upsertDailyLogTotals).not.toHaveBeenCalled();
    });
  });

  it('uses the home terminal timezone for the day range, not UTC', async () => {
    repo.driver = { ...repo.driver, homeTerminalTimezone: 'America/Los_Angeles' };
    const result = await service.recalculate({ driverId: 'driver-1' }, NOW);
    expect(result.days).toEqual(['2025-01-14']);
  });

  it('honours the driver ruleset', async () => {
    repo.driver = { ...repo.driver, hosRuleset: 'US_60_7_PROPERTY' };
    const result = await service.recalculate({ driverId: 'driver-1' }, NOW);
    expect(result.state?.cycleRemainingSec).toBe(60 * H);
  });

  it('honours the driver exception flags', async () => {
    repo.driver = { ...repo.driver, adverseDrivingEnabled: true };
    repo.events = OVER_LIMIT_DAY;
    const result = await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(result.state?.violations.map((v) => v.type)).toEqual(['BREAK_30']);
  });

  it('updates the daily log violation flags for every recalculated day', async () => {
    repo.events = OVER_LIMIT_DAY;
    await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-13' }, NOW);
    expect(repo.dailyFlagUpdates).toEqual([
      { logDate: '2025-01-13', count: 0 },
      { logDate: '2025-01-14', count: 2 },
    ]);
  });

  it('reports the computed state back to the caller', async () => {
    repo.events = OVER_LIMIT_DAY;
    const result = await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(result.state?.driveUsedSec).toBe(12 * H);
  });
  describe('computeCurrentState (§8.6 — read-only, for drift comparison)', () => {
    it('returns null for an unknown driver', async () => {
      repo.driver = null;
      expect(await service.computeCurrentState('nobody', NOW)).toBeNull();
    });

    it('returns the current state and the HOME TERMINAL timezone', async () => {
      repo.driver = { ...repo.driver, homeTerminalTimezone: 'America/Los_Angeles' };
      const result = await service.computeCurrentState('driver-1', NOW);
      expect(result?.timezone).toBe('America/Los_Angeles');
      expect(result?.state.currentStatus).toBeDefined();
    });

    it('computes the same state the recalculation reports', async () => {
      repo.events = OVER_LIMIT_DAY;
      const recalculated = await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
      const readOnly = await service.computeCurrentState('driver-1', NOW);
      expect(readOnly?.state.driveUsedSec).toBe(recalculated.state?.driveUsedSec);
      expect(readOnly?.state.violations.map((v) => v.type)).toEqual(recalculated.state?.violations.map((v) => v.type));
    });

    it('writes nothing — no violation, no daily-log flag', async () => {
      repo.events = OVER_LIMIT_DAY;
      await service.computeCurrentState('driver-1', NOW);
      expect(repo.upsertViolation).not.toHaveBeenCalled();
      expect(repo.autoClear).not.toHaveBeenCalled();
      expect(repo.dailyFlagUpdates).toEqual([]);
    });
  });
  describe('computeCurrentStates (batched, for GET /drivers/roster)', () => {
    it('returns an empty map and reads nothing for no drivers', async () => {
      const result = await service.computeCurrentStates([], NOW);
      expect(result.size).toBe(0);
      expect(repo.findEventsForDrivers).not.toHaveBeenCalled();
    });

    it('produces exactly the single-driver state, and ignores other drivers\' rows', async () => {
      repo.events = OVER_LIMIT_DAY;
      repo.dailyLogs = [{ logDate: new Date('2025-01-10T00:00:00Z'), onDutySec: 2 * H, drivingSec: 5 * H }];
      repo.otherDriverEvents = [{ driverId: 'driver-2', eventType: 1, eventCode: 3, eventDateTime: new Date('2025-01-14T20:00:00Z'), recordStatus: 1, eventSequenceId: 9 }];
      const single = await service.computeCurrentState('driver-1', NOW);
      const batch = await service.computeCurrentStates([repo.driver as never], NOW);
      expect(batch.get('driver-1')).toEqual(single?.state);
    });

    it('cuts each driver to its own home-terminal window when zones differ', async () => {
      const east = { ...repo.driver, id: 'driver-1' };
      const west = { ...repo.driver, id: 'driver-2', homeTerminalTimezone: 'Pacific/Honolulu' };
      repo.otherDriverEvents = [{ driverId: 'driver-2', eventType: 1, eventCode: 4, eventDateTime: new Date('2025-01-14T20:00:00Z'), recordStatus: 1, eventSequenceId: 1 }];
      const batch = await service.computeCurrentStates([east as never, west as never], NOW);
      const [windows] = repo.findEventsForDrivers.mock.calls[0];
      expect(windows.map((w) => [w.driverId, w.from.toISOString()])).toEqual([
        ['driver-1', '2025-01-05T05:00:00.000Z'],
        ['driver-2', '2025-01-05T10:00:00.000Z'],
      ]);
      expect(batch.get('driver-1')?.currentStatus).toBe('OFF');
      expect(batch.get('driver-2')?.currentStatus).toBe('ON');
    });
  });

  describe('computeCurrentStates — B-055 bounded per-driver reads', () => {
    type Row = FakeRepo['otherDriverEvents'][number];
    const base = (id: string, tz: string, extra: Record<string, unknown> = {}) => ({ ...new FakeRepo().driver, id, homeTerminalTimezone: tz, ...extra });
    const at = (driverId: string, iso: string, code: number, seq: number, eventType = 1): Row => ({ driverId, eventType, eventCode: code, eventDateTime: new Date(iso), recordStatus: 1, eventSequenceId: seq });

    /** The pre-B-055 reference: the single-driver path, run for one driver in isolation. */
    async function single(driver: Record<string, unknown>, rows: Row[]) {
      const own = new FakeRepo();
      own.driver = driver;
      own.events = rows.filter((r) => r.driverId === driver.id);
      return (await new HosRecalcService(own as unknown as HosRecalcRepository).computeCurrentState(driver.id as string, NOW))?.state;
    }

    /** 40 days of 11 h driving / 13 h off — far more history than the window, and no 34 h restart. */
    function longHistory(driverId: string): Row[] {
      const rows: Row[] = [];
      let seq = 1;
      for (let d = 40; d >= 1; d -= 1) {
        const day = new Date(NOW.getTime() - d * 24 * H * 1000);
        rows.push(at(driverId, new Date(day.getTime() - 6 * H * 1000).toISOString(), 3, seq++));
        rows.push(at(driverId, new Date(day.getTime() + 5 * H * 1000).toISOString(), 1, seq++));
      }
      return rows;
    }

    it('passes each driver its own lower bound and cap + 1 as the row limit', async () => {
      await service.computeCurrentStates([base('a', 'America/New_York') as never, base('b', 'America/Los_Angeles') as never], NOW);
      const [windows, to, limit] = repo.findEventsForDrivers.mock.calls[0];
      expect(windows).toEqual([
        { driverId: 'a', from: new Date('2025-01-05T05:00:00.000Z') },
        { driverId: 'b', from: new Date('2025-01-05T08:00:00.000Z') },
      ]);
      expect(to).toBe(NOW);
      expect(limit).toBe(HOS_BATCH_MAX_EVENTS_PER_DRIVER + 1);
    });

    it('a driver with a long history gets exactly the single-driver state', async () => {
      const driver = base('long', 'America/Chicago');
      repo.otherDriverEvents = longHistory('long');
      const batch = await service.computeCurrentStates([driver as never], NOW);
      expect(batch.get('long')).toEqual(await single(driver, repo.otherDriverEvents));
    });

    it('a driver with no recent 34 h restart keeps the whole cycle window and matches the single path', async () => {
      const driver = base('grind', 'America/New_York');
      repo.otherDriverEvents = longHistory('grind');
      const state = (await service.computeCurrentStates([driver as never], NOW)).get('grind');
      expect(state).toEqual(await single(driver, repo.otherDriverEvents));
      expect(state!.cycleRemainingSec).toBeLessThan(70 * H);
    });

    it('old vs new: a mixed fixture (zones, rulesets, PC/YM, other drivers, long + empty history) is identical per driver', async () => {
      const drivers = [
        base('ny', 'America/New_York'),
        base('la', 'America/Los_Angeles', { hosRuleset: 'US_60_7_PROPERTY' }),
        base('hi', 'Pacific/Honolulu', { adverseDrivingEnabled: true }),
        base('empty', 'America/Denver'),
        base('long', 'America/Phoenix', { splitSleeperEnabled: false }),
      ];
      repo.otherDriverEvents = [
        at('ny', '2025-01-14T05:00:00Z', 3, 1), at('ny', '2025-01-14T18:00:00Z', 1, 2),
        at('la', '2025-01-13T16:00:00Z', 4, 1), at('la', '2025-01-13T17:00:00Z', 1, 2, 3), at('la', '2025-01-13T18:00:00Z', 0, 3, 3),
        at('hi', '2025-01-14T20:00:00Z', 2, 1), at('hi', '2025-01-15T00:00:00Z', 3, 2),
        at('ny', '2024-12-01T05:00:00Z', 3, 0), at('stranger', '2025-01-14T20:00:00Z', 3, 1),
        { ...at('ny', '2025-01-14T19:00:00Z', 4, 9), recordStatus: 2 },
        at('ny', '2025-01-14T19:30:00Z', 5, 10, 2),
        ...longHistory('long'),
      ];
      const batch = await service.computeCurrentStates(drivers as never[], NOW);
      for (const driver of drivers) {
        expect(batch.get(driver.id)).toEqual(await single(driver, repo.otherDriverEvents));
      }
    });

    it('processes drivers in chunks so one call never reads the whole fleet', async () => {
      const drivers = Array.from({ length: HOS_BATCH_CHUNK_SIZE * 2 + 1 }, (_, i) => base(`d${i}`, 'America/New_York'));
      const batch = await service.computeCurrentStates(drivers as never[], NOW);
      expect(batch.size).toBe(drivers.length);
      expect(repo.findEventsForDrivers).toHaveBeenCalledTimes(3);
      expect(repo.findDailyLogsForDrivers).toHaveBeenCalledTimes(3);
      expect(repo.findEventsForDrivers.mock.calls.map(([w]) => w.length)).toEqual([HOS_BATCH_CHUNK_SIZE, HOS_BATCH_CHUNK_SIZE, 1]);
    });

    const flood = (driverId: string, count: number): Row[] =>
      Array.from({ length: count }, (_, i) => at(driverId, new Date(NOW.getTime() - (count - i) * 60_000).toISOString(), i % 2 ? 1 : 4, i + 1));

    it('computes a driver sitting exactly at the cap', async () => {
      repo.otherDriverEvents = flood('busy', HOS_BATCH_MAX_EVENTS_PER_DRIVER);
      const batch = await service.computeCurrentStates([base('busy', 'America/New_York') as never], NOW);
      expect(batch.has('busy')).toBe(true);
    });

    it('omits and logs a driver over the cap instead of computing clocks from a truncated window', async () => {
      const error = jest.spyOn((service as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, 'error').mockImplementation(() => undefined);
      repo.otherDriverEvents = [...flood('flood', HOS_BATCH_MAX_EVENTS_PER_DRIVER + 1), at('calm', '2025-01-14T20:00:00Z', 3, 1)];
      const batch = await service.computeCurrentStates([base('flood', 'America/New_York') as never, base('calm', 'America/New_York') as never], NOW);
      expect(batch.has('flood')).toBe(false);
      expect(batch.get('calm')?.currentStatus).toBe('D');
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ driverId: 'flood', cap: HOS_BATCH_MAX_EVENTS_PER_DRIVER }), expect.any(String));
    });
  });
});
