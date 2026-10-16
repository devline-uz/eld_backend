/**
 * BUG-003 — one web definition of an active violation. The dashboard read 0, the roster 1 and the
 * HOS log "No violations today" next to four exceeded clocks: the clocks are the live engine at
 * `now`, the lists were `HosViolation` rows only written when records arrive.
 */
import type { HosViolation } from '@prisma/client';
import type { HosState, Violation } from '../hos/hos.types';
import type { HosRecalcRepository, OpenDrivingRow } from '../hos-recalc/hos-recalc.repository';
import type { HosRecalcService } from '../hos-recalc/hos-recalc.service';
import { ActiveViolationsService } from './active-violations.service';
import type { ViolationsRepository } from './violations.repository';
import type { ViolationsService } from './violations.service';

const NOW = new Date('2026-10-12T15:00:00Z');
const TZ = 'America/New_York';

function openDriving(over: Partial<OpenDrivingRow> = {}): OpenDrivingRow {
  // Driving since 06:00 local — 5 h, a plausible status.
  return { driverId: 'drv-1', homeTerminalTimezone: TZ, since: new Date('2026-10-12T10:00:00Z'), ...over };
}

function violation(over: Partial<Violation> = {}): Violation {
  return { type: 'DRIVING_11', logDate: '2026-10-12', occurredAt: new Date('2026-10-12T14:00:00Z'), exceededBySec: 3600, detail: 'x', ...over };
}

function state(over: Partial<HosState> = {}): HosState {
  return {
    currentStatus: 'D',
    statusSince: new Date('2026-10-12T10:00:00Z'),
    driveRemainingSec: 0,
    shiftRemainingSec: 0,
    breakRemainingSec: 0,
    cycleRemainingSec: 0,
    driveUsedSec: 0,
    shiftStartedAt: null,
    lastBreakEndedAt: null,
    violations: [violation()],
    nextBreakDueAt: null,
    shiftEndsAt: null,
    cycleRecapAt: null,
    restartAvailableAt: null,
    dailyTotals: { off: 0, sb: 0, drive: 0, on: 0 },
    ...over,
  };
}

function row(over: Partial<HosViolation> = {}): HosViolation {
  return {
    id: 'vio-1',
    driverId: 'drv-1',
    dailyLogId: null,
    logDate: new Date('2026-10-12T00:00:00Z'),
    type: 'DRIVING_11',
    occurredAt: new Date('2026-10-12T14:00:00Z'),
    exceededBySec: 3600,
    detail: 'x',
    status: 'OPEN',
    recalcVersion: 1,
    resolvedAt: null,
    resolvedById: null,
    resolutionNote: null,
    ...over,
  };
}

function setup(opts: { rows?: OpenDrivingRow[]; state?: HosState; stored?: HosViolation[] } = {}) {
  const repo = { countByDriver: jest.fn().mockResolvedValue(new Map([['drv-1', 2]])) };
  const hos = {
    computeCurrentState: jest.fn().mockResolvedValue({ state: opts.state ?? state(), timezone: TZ }),
    recalculate: jest.fn().mockResolvedValue({}),
  };
  const hosRepo = {
    findOpenDrivingDrivers: jest.fn().mockResolvedValue(opts.rows ?? [openDriving()]),
    findViolations: jest.fn().mockResolvedValue(opts.stored ?? []),
  };
  const violations = { list: jest.fn().mockResolvedValue({ items: [], total: 0 }) };
  const service = new ActiveViolationsService(
    repo as unknown as ViolationsRepository,
    hos as unknown as HosRecalcService,
    hosRepo as unknown as HosRecalcRepository,
    violations as unknown as ViolationsService,
  );
  return { service, repo, hos, hosRepo, violations };
}

describe('ActiveViolationsService (BUG-003)', () => {
  it('files a violation the live engine holds but no row carries yet, before listing', async () => {
    const { service, hos, violations } = setup();
    await service.list({ status: 'OPEN', page: 1, limit: 25 } as never, NOW);
    expect(hos.recalculate).toHaveBeenCalledWith({ driverId: 'drv-1', fromDate: '2026-10-12' }, NOW);
    expect(violations.list).toHaveBeenCalledWith({ status: 'OPEN', page: 1, limit: 25 }, NOW, []);
  });

  it('writes nothing when every engine violation already has an OPEN or RESOLVED row', async () => {
    const { service, hos } = setup({ stored: [row({ status: 'RESOLVED' })] });
    await service.refresh(NOW);
    expect(hos.recalculate).not.toHaveBeenCalled();
  });

  it('re-files an AUTO_CLEARED row the engine shows again', async () => {
    const { service, hos } = setup({ stored: [row({ status: 'AUTO_CLEARED' })] });
    await service.refresh(NOW);
    expect(hos.recalculate).toHaveBeenCalledTimes(1);
  });

  it('checks a driver once per TTL, however many screens read', async () => {
    const { service, hos } = setup();
    await service.refresh(NOW);
    await service.openCountsByDriver(['drv-1'], new Date(NOW.getTime() + 1000));
    await service.activeFilter('drv-1', new Date(NOW.getTime() + 2000));
    expect(hos.computeCurrentState).toHaveBeenCalledTimes(1);
    // BE-01 — read with the per-day adverse limits `recalculate` files with.
    expect(hos.computeCurrentState).toHaveBeenCalledWith('drv-1', NOW, { perDayAdverse: true });
  });

  it('never writes from a STALE status and drops its rows after the cap (BUG-002)', async () => {
    // DRIVING since 2026-10-10 10:00Z — past the 16 h plausibility cap (2026-10-11 02:00Z).
    const since = new Date('2026-10-10T10:00:00Z');
    const { service, hos, repo } = setup({ rows: [openDriving({ since })], state: state({ statusSince: since, violations: [] }) });
    const counts = await service.openCountsByDriver(['drv-1'], NOW);
    expect(hos.recalculate).not.toHaveBeenCalled();
    expect(repo.countByDriver).toHaveBeenCalledWith({
      AND: [{ driverId: { in: ['drv-1'] }, status: 'OPEN' }, { NOT: { driverId: 'drv-1', occurredAt: { gt: new Date('2026-10-11T02:00:00Z') } } }],
    });
    expect(counts.get('drv-1')).toBe(2);

    const isActive = await service.activeFilter('drv-1', NOW);
    expect(isActive({ status: 'OPEN', occurredAt: new Date('2026-10-10T22:00:00Z') })).toBe(true);
    expect(isActive({ status: 'OPEN', occurredAt: new Date('2026-10-12T04:00:00Z') })).toBe(false);
  });

  it('UI-002a — files what a STALE driver crossed BEFORE the cap, reading the engine at the cap', async () => {
    const since = new Date('2026-10-10T10:00:00Z');
    const capAt = new Date('2026-10-11T02:00:00Z');
    const preCap = violation({ type: 'DRIVING_11', logDate: '2026-10-10', occurredAt: new Date('2026-10-10T21:00:00Z') });
    const { service, hos, repo } = setup({ rows: [openDriving({ since })], state: state({ statusSince: since, violations: [preCap] }) });
    await service.openCountsByDriver(['drv-1'], NOW);
    expect(hos.computeCurrentState).toHaveBeenNthCalledWith(2, 'drv-1', capAt, { perDayAdverse: true });
    expect(hos.recalculate).toHaveBeenCalledWith({ driverId: 'drv-1', fromDate: '2026-10-10' }, capAt);
    // The post-cap exclusion still applies.
    expect(repo.countByDriver).toHaveBeenCalledWith({
      AND: [{ driverId: { in: ['drv-1'] }, status: 'OPEN' }, { NOT: { driverId: 'drv-1', occurredAt: { gt: capAt } } }],
    });
  });

  it('UI-002a — a STALE driver whose pre-cap violation is already filed writes nothing', async () => {
    const since = new Date('2026-10-10T10:00:00Z');
    const preCap = violation({ logDate: '2026-10-10', occurredAt: new Date('2026-10-10T21:00:00Z') });
    const { service, hos } = setup({
      rows: [openDriving({ since })],
      state: state({ statusSince: since, violations: [preCap] }),
      stored: [row({ logDate: new Date('2026-10-10T00:00:00Z') })],
    });
    await service.refresh(NOW);
    expect(hos.recalculate).not.toHaveBeenCalled();
  });

  it('UI-002a — a failed write for a STALE driver still drops the rows after the cap', async () => {
    const since = new Date('2026-10-10T10:00:00Z');
    const preCap = violation({ logDate: '2026-10-10', occurredAt: new Date('2026-10-10T21:00:00Z') });
    const { service, hos } = setup({ rows: [openDriving({ since })], state: state({ statusSince: since, violations: [preCap] }) });
    hos.recalculate.mockRejectedValueOnce(new Error('boom'));
    await expect(service.refresh(NOW)).resolves.toEqual([{ NOT: { driverId: 'drv-1', occurredAt: { gt: new Date('2026-10-11T02:00:00Z') } } }]);
  });

  it('a failed engine check leaves the stored rows as they are', async () => {
    const { service, hos } = setup();
    hos.computeCurrentState.mockRejectedValueOnce(new Error('boom'));
    await expect(service.refresh(NOW)).resolves.toEqual([]);
  });

  it('CODE-030 — a cached stale cut-off is dropped once the driver is no longer open-driving', async () => {
    const since = new Date('2026-10-10T10:00:00Z');
    const { service, hosRepo } = setup({ rows: [openDriving({ since })], state: state({ statusSince: since, violations: [] }) });
    const stale = await service.activeFilter('drv-1', NOW);
    const later = { status: 'OPEN', occurredAt: new Date('2026-10-12T04:00:00Z') };
    expect(stale(later)).toBe(false);

    // A new record ended the stale DRIVING: the driver drops out of the open-driving scan (TTL passed).
    hosRepo.findOpenDrivingDrivers.mockResolvedValue([]);
    const fresh = await service.activeFilter('drv-1', new Date(NOW.getTime() + 61_000));
    expect(fresh(later)).toBe(true);
  });

  it('only checks the drivers asked for', async () => {
    const { service, hos } = setup({ rows: [openDriving({ driverId: 'drv-2' })] });
    await service.openCountsByDriver(['drv-1'], NOW);
    expect(hos.computeCurrentState).not.toHaveBeenCalled();
  });
});
