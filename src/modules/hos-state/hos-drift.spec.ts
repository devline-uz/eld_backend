/** TZ §8.6 point 5 — server-vs-app drift measurement. Pure: no DB, no Nest. */
import type { HosState } from '../hos/hos.types';
import { compareHosState, toMobileShape, HOS_DRIFT_THRESHOLD_SEC, type MobileHosState } from './hos-drift';

const NOW = new Date('2026-03-10T15:00:00.000Z');

function serverState(over: Partial<HosState> = {}): HosState {
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

function appState(over: Partial<MobileHosState> = {}): MobileHosState {
  return {
    currentStatus: 'D',
    driveRemainingSec: 3600,
    shiftRemainingSec: 7200,
    breakRemainingSec: 1800,
    cycleRemainingSec: 36000,
    dailyTotals: { off: 3600, sb: 0, drive: 36000, on: 1800 },
    violations: [],
    ...over,
  };
}

describe('compareHosState', () => {
  it('reports no drift when the two engines agree exactly', () => {
    const result = compareHosState(serverState(), appState());
    expect(result.maxDriftSec).toBe(0);
    expect(result.fields).toEqual([]);
    expect(result.drift).toBe(false);
    expect(result.statusMismatch).toBe(false);
  });

  it('the §8.6 threshold is 60 seconds', () => {
    expect(HOS_DRIFT_THRESHOLD_SEC).toBe(60);
  });

  it('59 s under the limit is measured but is NOT drift', () => {
    const result = compareHosState(serverState(), appState({ driveRemainingSec: 3600 - 59 }));
    expect(result.maxDriftSec).toBe(59);
    expect(result.drift).toBe(false);
  });

  it('exactly 60 s is NOT drift (the rule is "greater than 60")', () => {
    const result = compareHosState(serverState(), appState({ driveRemainingSec: 3600 - 60 }));
    expect(result.maxDriftSec).toBe(60);
    expect(result.drift).toBe(false);
  });

  it('61 s IS drift', () => {
    const result = compareHosState(serverState(), appState({ driveRemainingSec: 3600 - 61 }));
    expect(result.maxDriftSec).toBe(61);
    expect(result.drift).toBe(true);
    expect(result.fields[0].field).toBe('driveRemainingSec');
  });

  it('drift is symmetric — the app being ahead counts the same as being behind', () => {
    const behind = compareHosState(serverState(), appState({ shiftRemainingSec: 7200 - 600 }));
    const ahead = compareHosState(serverState(), appState({ shiftRemainingSec: 7200 + 600 }));
    expect(behind.maxDriftSec).toBe(600);
    expect(ahead.maxDriftSec).toBe(600);
    expect(behind.drift && ahead.drift).toBe(true);
  });

  it.each([
    ['driveRemainingSec', { driveRemainingSec: 0 }],
    ['shiftRemainingSec', { shiftRemainingSec: 0 }],
    ['breakRemainingSec', { breakRemainingSec: 0 }],
    ['cycleRemainingSec', { cycleRemainingSec: 0 }],
  ])('detects drift in %s', (field, over) => {
    const result = compareHosState(serverState(), appState(over));
    expect(result.drift).toBe(true);
    expect(result.fields.map((f) => f.field)).toContain(field);
  });

  it.each(['off', 'sb', 'drive', 'on'] as const)('detects drift in dailyTotals.%s', (key) => {
    const totals = { off: 3600, sb: 0, drive: 36000, on: 1800 };
    const result = compareHosState(serverState(), appState({ dailyTotals: { ...totals, [key]: totals[key] + 900 } }));
    expect(result.drift).toBe(true);
    expect(result.fields.map((f) => f.field)).toContain(`dailyTotals.${key}`);
  });

  it('a duty-status disagreement is drift even at zero seconds', () => {
    const result = compareHosState(serverState(), appState({ currentStatus: 'ON' }));
    expect(result.maxDriftSec).toBe(0);
    expect(result.statusMismatch).toBe(true);
    expect(result.drift).toBe(true);
    expect(result.serverStatus).toBe('D');
    expect(result.appStatus).toBe('ON');
  });

  it('a violation the app missed drifts by its whole magnitude', () => {
    const server = serverState({
      violations: [{ type: 'DRIVING_11', logDate: '2026-03-10', occurredAt: NOW, exceededBySec: 1560, detail: '' }],
    });
    const result = compareHosState(server, appState());
    expect(result.drift).toBe(true);
    expect(result.fields[0]).toMatchObject({ field: 'violation.DRIVING_11', serverSec: 1560, appSec: 0, diffSec: 1560 });
  });

  it('a violation the app invented drifts too', () => {
    const result = compareHosState(serverState(), appState({ violations: [{ type: 'SHIFT_14', exceededBySec: 300 }] }));
    expect(result.drift).toBe(true);
    expect(result.fields.map((f) => f.field)).toContain('violation.SHIFT_14');
  });

  it('a violation both sides agree on is not drift', () => {
    const server = serverState({
      violations: [{ type: 'BREAK_30', logDate: '2026-03-10', occurredAt: NOW, exceededBySec: 120, detail: '' }],
    });
    const result = compareHosState(server, appState({ violations: [{ type: 'BREAK_30', exceededBySec: 120 }] }));
    expect(result.drift).toBe(false);
    expect(result.maxDriftSec).toBe(0);
  });

  it('a violation whose magnitude differs by 61 s is drift', () => {
    const server = serverState({
      violations: [{ type: 'CYCLE_70', logDate: '2026-03-10', occurredAt: NOW, exceededBySec: 181, detail: '' }],
    });
    const result = compareHosState(server, appState({ violations: [{ type: 'CYCLE_70', exceededBySec: 120 }] }));
    expect(result.maxDriftSec).toBe(61);
    expect(result.drift).toBe(true);
  });

  it('keeps the WORST day when the server carries the same violation type twice', () => {
    const server = serverState({
      violations: [
        { type: 'DRIVING_11', logDate: '2026-03-09', occurredAt: NOW, exceededBySec: 60, detail: '' },
        { type: 'DRIVING_11', logDate: '2026-03-10', occurredAt: NOW, exceededBySec: 900, detail: '' },
      ],
    });
    expect(toMobileShape(server).violations).toEqual([{ type: 'DRIVING_11', exceededBySec: 900 }]);
    const result = compareHosState(server, appState({ violations: [{ type: 'DRIVING_11', exceededBySec: 900 }] }));
    expect(result.drift).toBe(false);
  });

  it('sorts the differing fields worst-first', () => {
    const result = compareHosState(
      serverState(),
      appState({ driveRemainingSec: 3600 - 100, shiftRemainingSec: 7200 - 5000, breakRemainingSec: 1800 - 10 }),
    );
    expect(result.fields.map((f) => f.diffSec)).toEqual([5000, 100, 10]);
  });

  it('only lists fields that actually differ', () => {
    const result = compareHosState(serverState(), appState({ cycleRemainingSec: 36000 - 5 }));
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0]).toEqual({ field: 'cycleRemainingSec', serverSec: 36000, appSec: 35995, diffSec: 5 });
  });

  it('toMobileShape drops internal timestamps, keeps the MR-24 ones and copies the counters', () => {
    const shape = toMobileShape(serverState());
    expect(Object.keys(shape).sort()).toEqual(
      [
        'breakRemainingSec',
        'currentStatus',
        'cycleRemainingSec',
        'dailyTotals',
        'driveRemainingSec',
        'shiftRemainingSec',
        'violations',
        // MR-24
        'statusSince',
        'nextBreakDueAt',
        'shiftEndsAt',
        'cycleRecapAt',
        'restartAvailableAt',
      ].sort(),
    );
    expect(shape.dailyTotals).not.toBe(serverState().dailyTotals);
  });

  it('ignores a zero-magnitude violation the other side does not have', () => {
    const result = compareHosState(serverState(), appState({ violations: [{ type: 'FORM_MANNER', exceededBySec: 0 }] }));
    expect(result.maxDriftSec).toBe(0);
    expect(result.drift).toBe(false);
  });

  it('sorts violation types deterministically', () => {
    const server = serverState({
      violations: [
        { type: 'SHIFT_14', logDate: '2026-03-10', occurredAt: NOW, exceededBySec: 10, detail: '' },
        { type: 'BREAK_30', logDate: '2026-03-10', occurredAt: NOW, exceededBySec: 20, detail: '' },
      ],
    });
    expect(toMobileShape(server).violations.map((v) => v.type)).toEqual(['BREAK_30', 'SHIFT_14']);
  });

  it('tolerates fractional server seconds by rounding before comparing', () => {
    const result = compareHosState(serverState({ driveRemainingSec: 3600.4 }), appState({ driveRemainingSec: 3600 }));
    expect(result.maxDriftSec).toBe(0);
    expect(result.drift).toBe(false);
  });
});
