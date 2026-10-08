/** TZ §8.6 point 5 — the nightly sweep: paging, version skips, per-driver isolation. */
import { Logger } from '@nestjs/common';
import type { DriverHosSnapshot } from '@prisma/client';
import { HOS_ENGINE_VERSION } from '../hos/hos.constants';
import { HosDriftService, DRIFT_SWEEP_PAGE_SIZE } from './hos-drift.service';
import type { HosStateRepository } from './hos-state.repository';
import type { CompareResult, HosStateService } from './hos-state.service';

const NOW = new Date('2026-03-10T08:00:00.000Z');

function snapshot(driverId: string, version = HOS_ENGINE_VERSION): DriverHosSnapshot {
  return { driverId, hosEngineVersion: version } as unknown as DriverHosSnapshot;
}

function compared(driverId: string, over: Partial<CompareResult> = {}): CompareResult {
  return { driverId, compared: true, skippedVersion: false, drift: false, maxDriftSec: 0, comparison: null, serverState: null, ...over };
}

function build(rows: DriverHosSnapshot[], compare?: jest.Mock) {
  const repo = {
    listSnapshots: jest.fn(async (after: string | null, take: number) => {
      const start = after ? rows.findIndex((r) => r.driverId === after) + 1 : 0;
      return rows.slice(start, start + take);
    }),
  };
  const state = {
    compareSnapshot:
      compare ??
      jest.fn(async (s: DriverHosSnapshot) =>
        s.hosEngineVersion === HOS_ENGINE_VERSION
          ? compared(s.driverId)
          : compared(s.driverId, { compared: false, skippedVersion: true, maxDriftSec: null }),
      ),
  };
  return {
    service: new HosDriftService(repo as unknown as HosStateRepository, state as unknown as HosStateService),
    repo,
    state,
  };
}

describe('HosDriftService.runNightlySweep', () => {
  it('reports an empty sweep when no app has ever posted a state', async () => {
    const { service, repo } = build([]);
    const result = await service.runNightlySweep(NOW);
    expect(result).toMatchObject({ scanned: 0, compared: 0, drifted: 0, failed: 0, skippedVersion: 0 });
    expect(result.hosEngineVersion).toBe(HOS_ENGINE_VERSION);
    expect(repo.listSnapshots).toHaveBeenCalledTimes(1);
  });

  it('compares every snapshot exactly once', async () => {
    const { service, state } = build([snapshot('a'), snapshot('b'), snapshot('c')]);
    const result = await service.runNightlySweep(NOW);
    expect(result.scanned).toBe(3);
    expect(result.compared).toBe(3);
    expect(state.compareSnapshot).toHaveBeenCalledTimes(3);
  });

  it('skips — never alerts on — a snapshot from a different engine version', async () => {
    const { service } = build([snapshot('a'), snapshot('b', '0.9.0'), snapshot('c', '2.0.0')]);
    const result = await service.runNightlySweep(NOW);
    expect(result.scanned).toBe(3);
    expect(result.compared).toBe(1);
    expect(result.skippedVersion).toBe(2);
    expect(result.drifted).toBe(0);
  });

  it('MR-1: counts stale snapshots separately and never as drift', async () => {
    const compare = jest.fn(async (s: DriverHosSnapshot) =>
      s.driverId === 'old'
        ? compared(s.driverId, { compared: false, skippedStale: true, staleSec: 200_000, maxDriftSec: null })
        : compared(s.driverId),
    );
    const { service } = build([snapshot('a'), snapshot('old')], compare);
    const result = await service.runNightlySweep(NOW);
    expect(result).toMatchObject({ scanned: 2, compared: 1, skippedStale: 1, skippedVersion: 0, drifted: 0 });
  });

  it('warns out loud when a version bump leaves part of the fleet uncomparable', async () => {
    const { service } = build([snapshot('a'), snapshot('b', '1.0.0')]);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const result = await service.runNightlySweep(NOW);
      expect(result.skippedVersion).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ skippedVersion: 1, scanned: 2, serverVersion: HOS_ENGINE_VERSION }),
        expect.stringContaining('stale, not drifting'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('says nothing about stale versions when the whole fleet is comparable', async () => {
    const { service } = build([snapshot('a'), snapshot('b')]);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await service.runNightlySweep(NOW);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('counts and names the drifting drivers', async () => {
    const compare = jest.fn(async (s: DriverHosSnapshot) =>
      compared(s.driverId, s.driverId === 'b' ? { drift: true, maxDriftSec: 900 } : {}),
    );
    const { service } = build([snapshot('a'), snapshot('b')], compare);
    const result = await service.runNightlySweep(NOW);
    expect(result.drifted).toBe(1);
    expect(result.driverIds).toEqual(['b']);
  });

  it('one failing driver never aborts the sweep', async () => {
    const compare = jest.fn(async (s: DriverHosSnapshot) => {
      if (s.driverId === 'b') throw new Error('engine blew up');
      return compared(s.driverId);
    });
    const { service } = build([snapshot('a'), snapshot('b'), snapshot('c')], compare);
    const result = await service.runNightlySweep(NOW);
    expect(result.scanned).toBe(3);
    expect(result.compared).toBe(2);
    expect(result.failed).toBe(1);
  });

  it('pages with a keyset cursor until the table is exhausted', async () => {
    const rows = Array.from({ length: DRIFT_SWEEP_PAGE_SIZE * 2 + 7 }, (_, i) =>
      snapshot(`d${String(i).padStart(4, '0')}`),
    );
    const { service, repo } = build(rows);
    const result = await service.runNightlySweep(NOW);
    expect(result.scanned).toBe(rows.length);
    expect(repo.listSnapshots).toHaveBeenCalledTimes(3);
    expect(repo.listSnapshots.mock.calls[0][0]).toBeNull();
    expect(repo.listSnapshots.mock.calls[1][0]).toBe(rows[DRIFT_SWEEP_PAGE_SIZE - 1].driverId);
  });

  it('stops after a full final page rather than looping forever', async () => {
    const rows = Array.from({ length: DRIFT_SWEEP_PAGE_SIZE }, (_, i) => snapshot(`d${i}`));
    const { service, repo } = build(rows);
    const result = await service.runNightlySweep(NOW);
    expect(result.scanned).toBe(DRIFT_SWEEP_PAGE_SIZE);
    expect(repo.listSnapshots).toHaveBeenCalledTimes(2);
  });

  it('passes the sweep instant through to every comparison', async () => {
    const { service, state } = build([snapshot('a')]);
    await service.runNightlySweep(NOW);
    expect(state.compareSnapshot).toHaveBeenCalledWith(expect.objectContaining({ driverId: 'a' }), NOW);
  });

  it('defaults the sweep instant to the current clock', async () => {
    const { service, state } = build([snapshot('a')]);
    await service.runNightlySweep();
    const calls = state.compareSnapshot.mock.calls as unknown[][];
    const at = calls[0][1] as Date;
    expect(at.getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it('is idempotent — a second run reports the same shape', async () => {
    const { service } = build([snapshot('a'), snapshot('b', '0.1.0')]);
    const first = await service.runNightlySweep(NOW);
    const second = await service.runNightlySweep(NOW);
    expect(second).toEqual(first);
  });
});
