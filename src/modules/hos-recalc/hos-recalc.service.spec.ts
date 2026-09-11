/** TZ §8.4 — recalculation is idempotent and never duplicates a violation. */
import { HosRecalcService, RECALC_LOOKBACK_DAYS } from './hos-recalc.service';
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
  dailyLogs: Array<{ logDate: Date; onDutySec: number; drivingSec: number }> = [];
  violations: FakeViolation[] = [];
  dailyFlagUpdates: Array<{ logDate: string; count: number }> = [];

  findDriver = jest.fn(async () => this.driver);
  findEvents = jest.fn(async (_id: string, from: Date, to: Date) => this.events.filter((e) => e.eventDateTime >= from && e.eventDateTime <= to));
  findDailyLogs = jest.fn(async (_id: string, from: Date, to: Date) => this.dailyLogs.filter((l) => l.logDate >= from && l.logDate <= to));
  findViolations = jest.fn(async (_id: string, from: Date, to: Date) => this.violations.filter((v) => v.logDate >= from && v.logDate <= to));

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
    repo.dailyLogs = [{ logDate: new Date('2025-01-13T00:00:00Z'), onDutySec: 40 * H, drivingSec: 20 * H }];
    const result = await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(result.state?.cycleRemainingSec).toBe(10 * H);
  });

  it('ignores DailyLog rows inside the recalculated range — those are recomputed', async () => {
    repo.dailyLogs = [{ logDate: new Date('2025-01-14T00:00:00Z'), onDutySec: 60 * H, drivingSec: 0 }];
    const result = await service.recalculate({ driverId: 'driver-1', fromDate: '2025-01-14' }, NOW);
    expect(result.state?.cycleRemainingSec).toBe(70 * H);
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
});
