import { computeDue, scheduleBaseline } from './maintenance-due';

const NOW = new Date('2026-09-11T00:00:00.000Z');

describe('computeDue (TZ §5.10)', () => {
  it('is OK when far from both the mileage and date interval', () => {
    const result = computeDue({
      intervalMi: 25000,
      intervalDays: 365,
      lastServiceMi: 990000,
      lastServiceAt: new Date('2026-06-01T00:00:00.000Z'),
      currentOdometerMi: 995000,
      now: NOW,
    });
    expect(result.state).toBe('OK');
    expect(result.nextDueMi).toBe(1015000);
  });

  it('is DUE_SOON within the mileage warning window', () => {
    const result = computeDue({
      intervalMi: 25000,
      intervalDays: null,
      lastServiceMi: 990000,
      lastServiceAt: null,
      currentOdometerMi: 1014800, // 200 mi from due — inside the 500 mi warning window
      now: NOW,
    });
    expect(result.state).toBe('DUE_SOON');
    expect(result.milesRemaining).toBe(200);
  });

  it('is OVERDUE once the odometer passes the mileage interval', () => {
    const result = computeDue({
      intervalMi: 25000,
      intervalDays: null,
      lastServiceMi: 990000,
      lastServiceAt: null,
      currentOdometerMi: 1015001,
      now: NOW,
    });
    expect(result.state).toBe('OVERDUE');
    expect(result.milesRemaining).toBeLessThan(0);
  });

  it('is OVERDUE once the date interval has passed, independent of mileage', () => {
    const result = computeDue({
      intervalMi: null,
      intervalDays: 365,
      lastServiceMi: null,
      lastServiceAt: new Date('2025-01-01T00:00:00.000Z'),
      currentOdometerMi: 0,
      now: NOW,
    });
    expect(result.state).toBe('OVERDUE');
  });

  it('whichever of mileage/date trips first wins — overdue on mileage, fine on date', () => {
    const result = computeDue({
      intervalMi: 25000,
      intervalDays: 365,
      lastServiceMi: 990000,
      lastServiceAt: NOW,
      currentOdometerMi: 1016000,
      now: NOW,
    });
    expect(result.state).toBe('OVERDUE');
  });
});

describe('QA CODE-037 — schedule without a recorded service', () => {
  const now = new Date('2026-10-14T12:00:00.000Z');

  it('is not overdue on creation: counts from the baseline odometer / date', () => {
    const due = computeDue({
      intervalMi: 25_000,
      intervalDays: 90,
      lastServiceMi: null,
      lastServiceAt: null,
      currentOdometerMi: 120_000,
      now,
      baselineMi: 120_000,
      baselineAt: now,
    });
    expect(due.state).toBe('OK');
    expect(due.nextDueMi).toBe(145_000);
    expect(due.daysRemaining).toBe(90);
  });

  it('does not evaluate an interval whose baseline is unknown (was: 0 mi / 1970 -> instantly overdue)', () => {
    const due = computeDue({ intervalMi: 25_000, intervalDays: 90, lastServiceMi: null, lastServiceAt: null, currentOdometerMi: 120_000, now });
    expect(due).toMatchObject({ state: 'OK', nextDueMi: null, nextDueAt: null, milesRemaining: null, daysRemaining: null });
  });

  it('a recorded service always wins over the baseline', () => {
    const due = computeDue({
      intervalMi: 10_000,
      intervalDays: null,
      lastServiceMi: 100_000,
      lastServiceAt: null,
      currentOdometerMi: 111_000,
      now,
      baselineMi: 110_000,
    });
    expect(due.state).toBe('OVERDUE');
  });

  it('scheduleBaseline recovers the creation baseline from the stored next-due point', () => {
    expect(
      scheduleBaseline({ intervalMi: 25_000, intervalDays: 90, nextDueMi: 145_000, nextDueAt: new Date('2027-01-12T12:00:00.000Z') }),
    ).toEqual({ baselineMi: 120_000, baselineAt: new Date('2026-10-14T12:00:00.000Z') });
  });

  it('scheduleBaseline treats rows saved by the old 0 mi / 1970 fallback as unknown', () => {
    expect(scheduleBaseline({ intervalMi: 25_000, intervalDays: 90, nextDueMi: 25_000, nextDueAt: new Date('1970-04-01T00:00:00.000Z') })).toEqual({
      baselineMi: null,
      baselineAt: null,
    });
  });
});

