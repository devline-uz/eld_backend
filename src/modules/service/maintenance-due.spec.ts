import { computeDue } from './maintenance-due';

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
