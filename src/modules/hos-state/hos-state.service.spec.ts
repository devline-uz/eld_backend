/** TZ §8.6 point 5 — `POST /mobile/hos-state`: store, compare, alert. */
import type { DriverHosSnapshot } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { HOS_ENGINE_VERSION } from '../hos/hos.constants';
import type { HosState } from '../hos/hos.types';
import type { HosStateDto } from './dto/hos-state.dto';
import type { HosStateRepository } from './hos-state.repository';
import { HosStateService, HOS_ENGINE_DRIFT_ALERT } from './hos-state.service';
import type { HosRecalcService } from '../hos-recalc/hos-recalc.service';
import type { EventBusService } from '../../core/events/event-bus.service';
import type { SentryCapture, SentryService } from '../../core/observability/sentry.service';

const NOW = new Date('2026-03-10T15:00:00.000Z');

function hosState(over: Partial<HosState> = {}): HosState {
  return {
    currentStatus: 'D',
    statusSince: NOW,
    driveRemainingSec: 3600,
    shiftRemainingSec: 7200,
    breakRemainingSec: 1800,
    cycleRemainingSec: 36000,
    driveUsedSec: 36000,
    shiftStartedAt: NOW,
    lastBreakEndedAt: null,
    violations: [],
    nextBreakDueAt: null,
    shiftEndsAt: null,
    cycleRecapAt: null,
    restartAvailableAt: null,
    dailyTotals: { off: 3600, sb: 0, drive: 36000, on: 1800 },
    ...over,
  };
}

function dto(over: Partial<HosStateDto> = {}): HosStateDto {
  return {
    computedAt: NOW,
    hosEngineVersion: HOS_ENGINE_VERSION,
    appPlatform: 'ANDROID',
    state: {
      currentStatus: 'D',
      driveRemainingSec: 3600,
      shiftRemainingSec: 7200,
      breakRemainingSec: 1800,
      cycleRemainingSec: 36000,
      dailyTotals: { off: 3600, sb: 0, drive: 36000, on: 1800 },
      violations: [],
    },
    ...over,
  };
}

class FakeRepo {
  rows = new Map<string, DriverHosSnapshot>();
  upsertSnapshot = jest.fn(async (input: Record<string, unknown>) => {
    const row = {
      receivedAt: NOW,
      lastComparedAt: null,
      maxDriftSec: null,
      driftAlerted: false,
      ...(this.rows.get(input.driverId as string) ?? {}),
      ...input,
    } as unknown as DriverHosSnapshot;
    this.rows.set(row.driverId, row);
    return row;
  });
  recordComparison = jest.fn(async (driverId: string, data: Record<string, unknown>) => {
    const row = { ...this.rows.get(driverId), ...data } as DriverHosSnapshot;
    this.rows.set(driverId, row);
    return row;
  });
  findSnapshot = jest.fn(async (driverId: string) => this.rows.get(driverId) ?? null);
  listSnapshots = jest.fn(async () => [...this.rows.values()]);
}

function build(serverState: HosState | null = hosState()) {
  const repo = new FakeRepo();
  const recalc = {
    computeCurrentState: jest.fn(async () =>
      serverState ? { state: serverState, timezone: 'America/New_York' } : null,
    ),
  };
  const events = { publish: jest.fn(async () => undefined) };
  const sentry = { capture: jest.fn<void, [SentryCapture]>() };
  const alertQueue = { add: jest.fn(async () => ({ id: '1' })) };
  const service = new HosStateService(
    repo as unknown as HosStateRepository,
    recalc as unknown as HosRecalcService,
    events as unknown as EventBusService,
    sentry as unknown as SentryService,
    alertQueue as never,
  );
  return { service, repo, recalc, events, sentry, alertQueue };
}

describe('HosStateService.submit', () => {
  it('stores the app state and reports the server engine version', async () => {
    const { service, repo } = build();
    const result = await service.submit('driver-1', dto(), NOW);
    expect(repo.upsertSnapshot).toHaveBeenCalledTimes(1);
    expect(repo.upsertSnapshot.mock.calls[0][0]).toMatchObject({
      driverId: 'driver-1',
      hosEngineVersion: HOS_ENGINE_VERSION,
      appPlatform: 'ANDROID',
    });
    expect(result.hosEngineVersion).toBe(HOS_ENGINE_VERSION);
    expect(result.accepted).toBe(true);
    expect(result.driftThresholdSec).toBe(60);
  });

  it('returns the server state so the app can show the authoritative numbers', async () => {
    const { service } = build();
    const result = await service.submit('driver-1', dto(), NOW);
    expect(result.serverState).toMatchObject({ currentStatus: 'D', driveRemainingSec: 3600 });
    expect(result.compared).toBe(true);
    expect(result.drift).toBe(false);
    expect(result.maxDriftSec).toBe(0);
  });

  it('computes the server state ONCE per submission', async () => {
    const { service, recalc } = build();
    await service.submit('driver-1', dto(), NOW);
    expect(recalc.computeCurrentState).toHaveBeenCalledTimes(1);
  });

  it('flags a version mismatch, stores the payload and skips the comparison (§8.6)', async () => {
    const { service, repo, recalc, alertQueue } = build();
    const result = await service.submit('driver-1', dto({ hosEngineVersion: '0.9.0' }), NOW);
    expect(repo.upsertSnapshot).toHaveBeenCalledTimes(1);
    expect(result.versionMismatch).toBe(true);
    expect(result.compared).toBe(false);
    expect(result.drift).toBe(false);
    expect(result.maxDriftSec).toBeNull();
    expect(result.serverState).toBeNull();
    expect(result.message).toContain('Update the app');
    expect(recalc.computeCurrentState).not.toHaveBeenCalled();
    expect(alertQueue.add).not.toHaveBeenCalled();
  });

  it('a version mismatch never records a comparison on the snapshot', async () => {
    const { service, repo } = build();
    await service.submit('driver-1', dto({ hosEngineVersion: '2.0.0' }), NOW);
    expect(repo.recordComparison).not.toHaveBeenCalled();
  });

  it('raises alert.hos_engine_drift + Sentry above 60 s', async () => {
    const { service, events, alertQueue, sentry } = build(hosState({ driveRemainingSec: 3600 }));
    const result = await service.submit(
      'driver-1',
      dto({ state: { ...dto().state, driveRemainingSec: 3600 - 900 } }),
      NOW,
    );
    expect(result.drift).toBe(true);
    expect(result.maxDriftSec).toBe(900);
    expect(events.publish).toHaveBeenCalledWith(HOS_ENGINE_DRIFT_ALERT, expect.objectContaining({ driverId: 'driver-1', maxDriftSec: 900 }));
    expect(alertQueue.add).toHaveBeenCalledWith(HOS_ENGINE_DRIFT_ALERT, expect.objectContaining({ thresholdSec: 60 }));
    expect(sentry.capture).toHaveBeenCalledTimes(1);
    expect(sentry.capture.mock.calls[0][0]).toMatchObject({
      message: 'HOS engine drift',
      level: 'error',
      tags: { driverId: 'driver-1', worstField: 'driveRemainingSec', hosEngineVersion: HOS_ENGINE_VERSION, appPlatform: 'ANDROID' },
    });
  });

  it('does not alert at exactly 60 s', async () => {
    const { service, events, alertQueue, sentry } = build();
    const result = await service.submit('driver-1', dto({ state: { ...dto().state, driveRemainingSec: 3540 } }), NOW);
    expect(result.drift).toBe(false);
    expect(events.publish).not.toHaveBeenCalled();
    expect(alertQueue.add).not.toHaveBeenCalled();
    expect(sentry.capture).not.toHaveBeenCalled();
  });

  it('alerts on a duty-status disagreement even at zero drift', async () => {
    const { service, sentry } = build();
    const result = await service.submit('driver-1', dto({ state: { ...dto().state, currentStatus: 'ON' } }), NOW);
    expect(result.statusMismatch).toBe(true);
    expect(result.drift).toBe(true);
    expect(sentry.capture.mock.calls[0][0].tags?.worstField).toBe('currentStatus');
  });

  it('persists the comparison outcome on the snapshot', async () => {
    const { service, repo } = build();
    await service.submit('driver-1', dto({ state: { ...dto().state, shiftRemainingSec: 0 } }), NOW);
    expect(repo.recordComparison).toHaveBeenCalledWith('driver-1', {
      lastComparedAt: NOW,
      maxDriftSec: 7200,
      driftAlerted: true,
    });
  });

  it('clears driftAlerted when a later comparison is clean', async () => {
    const { service, repo } = build();
    await service.submit('driver-1', dto({ state: { ...dto().state, shiftRemainingSec: 0 } }), NOW);
    await service.submit('driver-1', dto(), NOW);
    expect(repo.recordComparison).toHaveBeenLastCalledWith('driver-1', {
      lastComparedAt: NOW,
      maxDriftSec: 0,
      driftAlerted: false,
    });
  });

  it('still reports Sentry when the alert queue is unreachable', async () => {
    const { service, alertQueue, sentry } = build();
    alertQueue.add.mockRejectedValueOnce(new Error('redis down'));
    const result = await service.submit('driver-1', dto({ state: { ...dto().state, cycleRemainingSec: 0 } }), NOW);
    expect(result.drift).toBe(true);
    expect(sentry.capture).toHaveBeenCalledTimes(1);
  });

  it('accepts a payload without an app platform', async () => {
    const { service, repo } = build();
    const body = dto();
    delete body.appPlatform;
    await service.submit('driver-1', body, NOW);
    expect(repo.upsertSnapshot.mock.calls[0][0]).toMatchObject({ appPlatform: null });
  });

  it('tags an unknown platform as UNKNOWN in the Sentry event', async () => {
    const { service, sentry } = build();
    const body = dto({ state: { ...dto().state, breakRemainingSec: 0 } });
    delete body.appPlatform;
    await service.submit('driver-1', body, NOW);
    expect(sentry.capture.mock.calls[0][0].tags?.appPlatform).toBe('UNKNOWN');
  });

  it('defaults `now` to the current clock', async () => {
    const { service, repo } = build();
    await service.submit('driver-1', dto());
    const recorded = repo.recordComparison.mock.calls[0][1] as { lastComparedAt: Date };
    expect(recorded.lastComparedAt.getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it('404s when the driver row disappeared mid-request', async () => {
    const { service } = build(null);
    await expect(service.submit('ghost', dto(), NOW)).rejects.toBeInstanceOf(AppException);
  });
});

describe('HosStateService.compareSnapshot', () => {
  const snapshot = (over: Record<string, unknown> = {}): DriverHosSnapshot =>
    ({
      driverId: 'driver-1',
      computedAt: NOW,
      receivedAt: NOW,
      hosEngineVersion: HOS_ENGINE_VERSION,
      appPlatform: 'IOS',
      state: {
        currentStatus: 'D',
        driveRemainingSec: 3600,
        shiftRemainingSec: 7200,
        breakRemainingSec: 1800,
        cycleRemainingSec: 36000,
        dailyTotals: { off: 3600, sb: 0, drive: 36000, on: 1800 },
        violations: [],
      },
      lastComparedAt: null,
      maxDriftSec: null,
      driftAlerted: false,
      ...over,
    }) as unknown as DriverHosSnapshot;

  it('skips a snapshot written by a different engine version', async () => {
    const { service, recalc, repo } = build();
    const result = await service.compareSnapshot(snapshot({ hosEngineVersion: '0.0.1' }), NOW);
    expect(result).toMatchObject({ compared: false, skippedVersion: true, drift: false, maxDriftSec: null });
    expect(recalc.computeCurrentState).not.toHaveBeenCalled();
    expect(repo.recordComparison).not.toHaveBeenCalled();
  });

  it('skips a snapshot whose driver no longer exists', async () => {
    const { service, repo } = build(null);
    const result = await service.compareSnapshot(snapshot(), NOW);
    expect(result).toMatchObject({ compared: false, skippedVersion: false, drift: false });
    expect(repo.recordComparison).not.toHaveBeenCalled();
  });

  it('compares a matching-version snapshot and returns the server shape', async () => {
    const { service } = build();
    const result = await service.compareSnapshot(snapshot(), NOW);
    expect(result.compared).toBe(true);
    expect(result.drift).toBe(false);
    expect(result.serverState).toMatchObject({ currentStatus: 'D' });
  });

  it('carries the app platform into the alert payload', async () => {
    const { service, events } = build();
    await service.compareSnapshot(
      snapshot({ state: { ...(snapshot().state as object), currentStatus: 'OFF' } }),
      NOW,
    );
    expect(events.publish).toHaveBeenCalledWith(
      HOS_ENGINE_DRIFT_ALERT,
      expect.objectContaining({ appPlatform: 'IOS', appStatus: 'OFF', serverStatus: 'D' }),
    );
  });
});
