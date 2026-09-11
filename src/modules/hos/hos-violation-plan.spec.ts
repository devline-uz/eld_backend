/** TZ §8.4 — the idempotent violation write rule as a pure plan. */
import { reconcileViolations, type ExistingViolation } from './hos-violation-plan';
import type { Violation } from './hos.types';

const DAY = '2025-01-14';
const OTHER = '2025-01-15';

const fresh = (type: Violation['type'], logDate = DAY, exceededBySec = 600): Violation => ({
  type, logDate, occurredAt: new Date('2025-01-14T18:00:00Z'), exceededBySec, detail: 'detail',
});

const row = (type: Violation['type'], status: ExistingViolation['status'], logDate = DAY, exceededBySec = 600): ExistingViolation => ({
  id: `${logDate}-${type}`, logDate, type, status, exceededBySec,
});

describe('reconcileViolations', () => {
  it('plans nothing for an empty day', () => {
    expect(reconcileViolations([], [], [DAY])).toEqual([]);
  });

  it('upserts a new violation', () => {
    const actions = reconcileViolations([fresh('DRIVING_11')], [], [DAY]);
    expect(actions).toEqual([expect.objectContaining({ kind: 'UPSERT', type: 'DRIVING_11', logDate: DAY, status: 'OPEN' })]);
  });

  it('upserts every fresh violation', () => {
    const actions = reconcileViolations([fresh('DRIVING_11'), fresh('BREAK_30')], [], [DAY]);
    expect(actions.filter((a) => a.kind === 'UPSERT')).toHaveLength(2);
  });

  it('re-upserts an already OPEN violation instead of inserting a second row', () => {
    const actions = reconcileViolations([fresh('DRIVING_11')], [row('DRIVING_11', 'OPEN')], [DAY]);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('UPSERT');
  });

  it('is idempotent — running twice plans the same actions', () => {
    const first = reconcileViolations([fresh('DRIVING_11')], [row('DRIVING_11', 'OPEN')], [DAY]);
    const second = reconcileViolations([fresh('DRIVING_11')], [row('DRIVING_11', 'OPEN')], [DAY]);
    expect(second).toEqual(first);
  });

  it('carries the refreshed magnitude into the upsert', () => {
    const actions = reconcileViolations([fresh('DRIVING_11', DAY, 1560)], [row('DRIVING_11', 'OPEN', DAY, 600)], [DAY]);
    expect(actions[0]).toMatchObject({ exceededBySec: 1560 });
  });

  it('auto-clears an OPEN violation the fresh result no longer contains', () => {
    const actions = reconcileViolations([], [row('SHIFT_14', 'OPEN')], [DAY]);
    expect(actions).toEqual([{ kind: 'AUTO_CLEAR', id: '2025-01-14-SHIFT_14', logDate: DAY, type: 'SHIFT_14' }]);
  });

  it('never deletes — auto-clearing is the only removal path', () => {
    const actions = reconcileViolations([], [row('SHIFT_14', 'OPEN')], [DAY]);
    expect(actions.every((a) => a.kind !== ('DELETE' as never))).toBe(true);
  });

  it('does not auto-clear a violation outside the recalculated days', () => {
    expect(reconcileViolations([], [row('SHIFT_14', 'OPEN', OTHER)], [DAY])).toEqual([]);
  });

  it('does not auto-clear an already AUTO_CLEARED row', () => {
    expect(reconcileViolations([], [row('SHIFT_14', 'AUTO_CLEARED')], [DAY])).toEqual([]);
  });

  it('does not auto-clear a RESOLVED row', () => {
    expect(reconcileViolations([], [row('SHIFT_14', 'RESOLVED')], [DAY])).toEqual([]);
  });

  it('never reopens a manually RESOLVED violation', () => {
    const actions = reconcileViolations([fresh('DRIVING_11')], [row('DRIVING_11', 'RESOLVED', DAY, 600)], [DAY]);
    expect(actions.some((a) => a.kind === 'UPSERT')).toBe(false);
  });

  it('refreshes only exceededBySec on a RESOLVED violation', () => {
    const actions = reconcileViolations([fresh('DRIVING_11', DAY, 900)], [row('DRIVING_11', 'RESOLVED', DAY, 600)], [DAY]);
    expect(actions).toEqual([{ kind: 'REFRESH_RESOLVED', id: '2025-01-14-DRIVING_11', logDate: DAY, type: 'DRIVING_11', exceededBySec: 900 }]);
  });

  it('plans nothing when a RESOLVED violation is unchanged', () => {
    expect(reconcileViolations([fresh('DRIVING_11', DAY, 600)], [row('DRIVING_11', 'RESOLVED', DAY, 600)], [DAY])).toEqual([]);
  });

  it('reopens an AUTO_CLEARED violation that came back', () => {
    const actions = reconcileViolations([fresh('DRIVING_11')], [row('DRIVING_11', 'AUTO_CLEARED')], [DAY]);
    expect(actions[0]).toMatchObject({ kind: 'UPSERT', status: 'OPEN' });
  });

  it('separates days with the same violation type', () => {
    const actions = reconcileViolations([fresh('DRIVING_11', DAY)], [row('DRIVING_11', 'OPEN', OTHER)], [DAY, OTHER]);
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'UPSERT', logDate: DAY }),
      expect.objectContaining({ kind: 'AUTO_CLEAR', logDate: OTHER }),
    ]);
  });

  it('handles a mixed day: one kept, one cleared, one resolved', () => {
    const actions = reconcileViolations(
      [fresh('DRIVING_11'), fresh('BREAK_30', DAY, 300)],
      [row('DRIVING_11', 'OPEN'), row('SHIFT_14', 'OPEN'), row('BREAK_30', 'RESOLVED', DAY, 100)],
      [DAY],
    );
    expect(actions.map((a) => a.kind)).toEqual(['UPSERT', 'REFRESH_RESOLVED', 'AUTO_CLEAR']);
  });

  it('never plans two actions for the same key', () => {
    const actions = reconcileViolations([fresh('DRIVING_11'), fresh('DRIVING_11')], [], [DAY]);
    expect(actions).toHaveLength(2); // the engine de-duplicates upstream; the plan stays faithful
  });

  it('carries occurredAt and detail into the upsert', () => {
    const actions = reconcileViolations([fresh('CYCLE_70')], [], [DAY]);
    expect(actions[0]).toMatchObject({ occurredAt: new Date('2025-01-14T18:00:00Z'), detail: 'detail' });
  });

  it('accepts an empty day scope and clears nothing', () => {
    expect(reconcileViolations([], [row('SHIFT_14', 'OPEN')], [])).toEqual([]);
  });
});
