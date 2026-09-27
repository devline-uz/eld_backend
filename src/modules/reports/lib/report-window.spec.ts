import { resolveScheduleParams } from './report-window';

/** B-48 — `params.window` resolution, run in the schedule's own timezone (never the server's,
 * TZ §23 DST-correctness rule the whole `hos/engine/timezone.ts` module exists to enforce for
 * the same reason). */
describe('resolveScheduleParams', () => {
  const now = new Date('2026-09-24T12:00:00.000Z'); // Thursday

  it('passes params through unchanged when there is no window', () => {
    const params = { from: '2026-01-01', to: '2026-01-08' };
    expect(resolveScheduleParams('ACTIVITY', params, 'UTC', now)).toEqual(params);
  });

  it('PREVIOUS_WEEK resolves to last Mon-Sun for from/to types', () => {
    const result = resolveScheduleParams('ACTIVITY', { window: 'PREVIOUS_WEEK' }, 'UTC', now);
    // 2026-09-24 is a Thursday; this week started Mon 2026-09-21, so previous week is
    // 2026-09-14 (Mon) .. 2026-09-20 (Sun).
    expect(result).toEqual({ from: '2026-09-14', to: '2026-09-20' });
  });

  it('PREVIOUS_MONTH resolves to the full previous calendar month', () => {
    const result = resolveScheduleParams('DVIR', { window: 'PREVIOUS_MONTH' }, 'UTC', now);
    expect(result).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('PREVIOUS_QUARTER resolves to the full previous calendar quarter for from/to types', () => {
    // now is in Q3 (Jul-Sep 2026); previous quarter is Q2 (Apr-Jun 2026).
    const result = resolveScheduleParams('FMCSA_PACK', { window: 'PREVIOUS_QUARTER' }, 'UTC', now);
    expect(result).toEqual({ from: '2026-04-01', to: '2026-06-30' });
  });

  it('IFTA resolves window to a quarter label, not from/to', () => {
    const result = resolveScheduleParams('IFTA', { window: 'PREVIOUS_QUARTER' }, 'UTC', now);
    expect(result).toEqual({ quarter: '2026-Q2' });
  });

  it('drops the window key itself and keeps other params', () => {
    const result = resolveScheduleParams('ACTIVITY', { window: 'PREVIOUS_WEEK', driverId: 'drv_1' }, 'UTC', now);
    expect(result).toEqual({ from: '2026-09-14', to: '2026-09-20', driverId: 'drv_1' });
  });

  it('resolves in the schedule timezone, not UTC, near a UTC day boundary', () => {
    // 2026-09-24T02:00Z is still 2026-09-23 21:00 in America/New_York (UTC-4 in September) —
    // the previous month in NY is still August even though UTC has already rolled to Sep 24.
    const earlyUtc = new Date('2026-10-01T02:00:00.000Z');
    const resultUtc = resolveScheduleParams('DVIR', { window: 'PREVIOUS_MONTH' }, 'UTC', earlyUtc);
    const resultNy = resolveScheduleParams('DVIR', { window: 'PREVIOUS_MONTH' }, 'America/New_York', earlyUtc);
    expect(resultUtc).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(resultNy).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });
});
