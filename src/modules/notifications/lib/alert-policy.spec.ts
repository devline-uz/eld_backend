import { evaluateAlertPolicy, isWithinQuietHours, startOfLocalDay } from './alert-policy';

describe('alert-policy — throttle', () => {
  it('allows delivery when under the daily cap', () => {
    const decision = evaluateAlertPolicy({
      now: new Date('2026-09-11T18:00:00.000Z'),
      zone: 'America/New_York',
      throttle: { perDriverPerDay: 3 },
      deliveriesTodayCount: 2,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('blocks delivery exactly AT the daily cap (boundary)', () => {
    const decision = evaluateAlertPolicy({
      now: new Date('2026-09-11T18:00:00.000Z'),
      zone: 'America/New_York',
      throttle: { perDriverPerDay: 3 },
      deliveriesTodayCount: 3,
    });
    expect(decision).toEqual({ allowed: false, reason: 'THROTTLED' });
  });

  it('is unlimited when perDriverPerDay is not set', () => {
    const decision = evaluateAlertPolicy({
      now: new Date(),
      zone: 'UTC',
      throttle: {},
      deliveriesTodayCount: 999,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('alert-policy — cooldown', () => {
  it('blocks a second delivery inside the cooldown window', () => {
    const decision = evaluateAlertPolicy({
      now: new Date('2026-09-11T18:10:00.000Z'),
      zone: 'UTC',
      throttle: { cooldownMin: 30 },
      deliveriesTodayCount: 1,
      lastDeliveredAt: new Date('2026-09-11T18:00:00.000Z'),
    });
    expect(decision).toEqual({ allowed: false, reason: 'COOLDOWN' });
  });

  it('allows exactly AT the cooldown boundary (elapsed === cooldownMin)', () => {
    const decision = evaluateAlertPolicy({
      now: new Date('2026-09-11T18:30:00.000Z'),
      zone: 'UTC',
      throttle: { cooldownMin: 30 },
      deliveriesTodayCount: 1,
      lastDeliveredAt: new Date('2026-09-11T18:00:00.000Z'),
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('blocks one millisecond before the cooldown boundary', () => {
    const decision = evaluateAlertPolicy({
      now: new Date('2026-09-11T18:29:59.999Z'),
      zone: 'UTC',
      throttle: { cooldownMin: 30 },
      deliveriesTodayCount: 1,
      lastDeliveredAt: new Date('2026-09-11T18:00:00.000Z'),
    });
    expect(decision).toEqual({ allowed: false, reason: 'COOLDOWN' });
  });

  it('ignores cooldown when there was no previous delivery', () => {
    const decision = evaluateAlertPolicy({
      now: new Date(),
      zone: 'UTC',
      throttle: { cooldownMin: 30 },
      deliveriesTodayCount: 0,
      lastDeliveredAt: null,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('alert-policy — quiet hours (subject timezone, not server local)', () => {
  const quietHours = { from: '22:00', to: '06:00', timezone: 'America/Chicago' };

  it('suppresses inside an overnight-wrapping window', () => {
    // 2026-09-12T03:00:00Z is 2026-09-11 22:00 America/Chicago (CDT, UTC-5) — exactly `from`.
    const decision = evaluateAlertPolicy({
      now: new Date('2026-09-12T03:00:00.000Z'),
      zone: 'America/Chicago',
      quietHours,
      deliveriesTodayCount: 0,
    });
    expect(decision).toEqual({ allowed: false, reason: 'QUIET_HOURS' });
  });

  it('allows exactly at the `to` boundary (window is half-open [from, to))', () => {
    // 2026-09-12T11:00:00Z is 06:00 America/Chicago.
    const decision = evaluateAlertPolicy({
      now: new Date('2026-09-12T11:00:00.000Z'),
      zone: 'America/Chicago',
      quietHours,
      deliveriesTodayCount: 0,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('allows outside the window entirely', () => {
    const decision = evaluateAlertPolicy({
      now: new Date('2026-09-11T18:00:00.000Z'), // 13:00 Chicago
      zone: 'America/Chicago',
      quietHours,
      deliveriesTodayCount: 0,
    });
    expect(decision.allowed).toBe(true);
  });

  it('uses the SUBJECT timezone, not server-local: same UTC instant, different zone -> different result', () => {
    const now = new Date('2026-09-12T03:00:00.000Z');
    const chicago = evaluateAlertPolicy({ now, zone: 'America/Chicago', quietHours, deliveriesTodayCount: 0 });
    const tokyo = evaluateAlertPolicy({
      now,
      zone: 'Asia/Tokyo',
      quietHours: { ...quietHours, timezone: 'Asia/Tokyo' },
      deliveriesTodayCount: 0,
    });
    expect(chicago.allowed).toBe(false); // 22:00 Chicago — quiet
    expect(tokyo.allowed).toBe(true); // 12:00 Tokyo — not quiet
  });

  it('CRITICAL severity bypasses quiet hours', () => {
    const decision = evaluateAlertPolicy({
      now: new Date('2026-09-12T03:00:00.000Z'),
      zone: 'America/Chicago',
      quietHours,
      deliveriesTodayCount: 0,
      bypassQuietHours: true,
    });
    expect(decision.allowed).toBe(true);
  });

  it('a zero-width window (from === to) never suppresses', () => {
    expect(isWithinQuietHours(new Date(), 'UTC', { from: '05:00', to: '05:00', timezone: 'UTC' })).toBe(false);
  });
});

describe('alert-policy — precedence: throttle before cooldown before quiet hours', () => {
  it('reports THROTTLED even when also in cooldown and quiet hours', () => {
    const decision = evaluateAlertPolicy({
      now: new Date('2026-09-12T03:00:00.000Z'),
      zone: 'America/Chicago',
      throttle: { perDriverPerDay: 1, cooldownMin: 999 },
      quietHours: { from: '22:00', to: '06:00', timezone: 'America/Chicago' },
      deliveriesTodayCount: 1,
      lastDeliveredAt: new Date('2026-09-12T02:59:00.000Z'),
    });
    expect(decision.reason).toBe('THROTTLED');
  });
});

describe('startOfLocalDay', () => {
  it('returns midnight in the subject zone, converted to UTC', () => {
    const start = startOfLocalDay(new Date('2026-09-12T03:30:00.000Z'), 'America/Chicago');
    // 2026-09-12T03:30 UTC is 2026-09-11 22:30 Chicago -> local midnight is 2026-09-11T00:00 Chicago
    // = 2026-09-11T05:00:00.000Z (CDT, UTC-5).
    expect(start.toISOString()).toBe('2026-09-11T05:00:00.000Z');
  });
});
