/** LIVE-001 / CODE-006 / CODE-007 — the pure plan behind `scripts/hos-recalc-backfill.ts`. */
import { isUnclosedAssignment, parseBackfillArgs, planBackfillJobs } from './hos-backfill';

describe('parseBackfillArgs', () => {
  it('is a dry run by default', () => {
    expect(parseBackfillArgs([])).toEqual({ apply: false, driverIds: [], from: null, allDrivers: false, unidentifiedReport: false });
  });

  it('reads --apply, repeatable --driver, --from (both spellings) and --unidentified-report', () => {
    expect(parseBackfillArgs(['--apply', '--driver', 'a', '--driver=b', '--from=2026-09-01', '--unidentified-report'])).toEqual({
      apply: true, driverIds: ['a', 'b'], from: '2026-09-01', allDrivers: false, unidentifiedReport: true,
    });
  });

  it('refuses an unbounded --all-drivers, a bad date and unknown flags', () => {
    expect(() => parseBackfillArgs(['--all-drivers'])).toThrow(/--from/);
    expect(() => parseBackfillArgs(['--from', '09/01/2026'])).toThrow(/YYYY-MM-DD/);
    expect(() => parseBackfillArgs(['--force'])).toThrow(/Unknown/);
  });
});

describe('planBackfillJobs', () => {
  const today = '2026-10-15';

  it('LIVE-001: recalculates each driver from their EARLIEST open violation, so the orphan day is in range', () => {
    const jobs = planBackfillJobs(
      [{ driverId: 'john', earliestOpen: '2026-09-26', openCount: 1 }, { driverId: 'amy', earliestOpen: '2026-10-01', openCount: 3 }],
      { from: null, today },
    );
    expect(jobs).toEqual([
      { driverId: 'john', fromDate: '2026-09-26', openCount: 1 },
      { driverId: 'amy', fromDate: '2026-10-01', openCount: 3 },
    ]);
  });

  it('--from only moves a start EARLIER, never later than an open violation', () => {
    const jobs = planBackfillJobs([{ driverId: 'john', earliestOpen: '2026-09-26', openCount: 1 }], { from: '2026-10-01', today });
    expect(jobs[0].fromDate).toBe('2026-09-26');
    expect(planBackfillJobs([{ driverId: 'john', earliestOpen: '2026-09-26', openCount: 1 }], { from: '2026-09-01', today })[0].fromDate).toBe('2026-09-01');
  });

  it('--all-drivers adds drivers without open rows from --from (CODE-006), one job per driver', () => {
    const jobs = planBackfillJobs([{ driverId: 'john', earliestOpen: '2026-09-26', openCount: 1 }], {
      from: '2026-09-20', allDriverIds: ['john', 'zed'], today,
    });
    expect(jobs).toEqual([
      { driverId: 'john', fromDate: '2026-09-20', openCount: 1 },
      { driverId: 'zed', fromDate: '2026-09-20', openCount: 0 },
    ]);
  });

  it('--driver limits the plan, and a future date is clamped to today', () => {
    const jobs = planBackfillJobs(
      [{ driverId: 'john', earliestOpen: '2026-12-01', openCount: 1 }, { driverId: 'amy', earliestOpen: '2026-10-01', openCount: 1 }],
      { from: null, driverIds: ['john'], today },
    );
    expect(jobs).toEqual([{ driverId: 'john', fromDate: today, openCount: 1 }]);
  });
});

describe('isUnclosedAssignment (CODE-007 report)', () => {
  it('flags a segment end with no active duty-status record of the driver', () => {
    expect(isUnclosedAssignment([])).toBe(true);
    expect(isUnclosedAssignment([{ id: 1n, eventType: 3, recordStatus: 1, supersedesId: null }])).toBe(true);
  });

  it('a record at the end that was retired does not close it; an active one does', () => {
    const retired = [
      { id: 1n, eventType: 1, recordStatus: 1, supersedesId: null },
      { id: 2n, eventType: 1, recordStatus: 2, supersedesId: 1n },
    ];
    expect(isUnclosedAssignment(retired)).toBe(true);
    expect(isUnclosedAssignment([{ id: 3n, eventType: 1, recordStatus: 1, supersedesId: null }])).toBe(false);
  });
});
