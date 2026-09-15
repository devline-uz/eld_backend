import { seedFixTime } from './live-fleet.seed';

describe('seedFixTime (B-044 — seeded positions are never in the future)', () => {
  const anchor = new Date('2026-09-14T19:41:00.000Z'); // 15:41 America/New_York

  it('uses real now when the seed runs before the anchor (the B-044 case, 08:42 UTC)', () => {
    const now = new Date('2026-09-14T08:42:00.000Z');
    expect(seedFixTime(anchor, now, 3).toISOString()).toBe('2026-09-14T08:39:00.000Z');
  });

  it('uses the anchor when the seed runs after it', () => {
    const now = new Date('2026-09-14T22:00:00.000Z');
    expect(seedFixTime(anchor, now, 2).toISOString()).toBe('2026-09-14T19:39:00.000Z');
  });

  it('is never later than now for any offset, including a negative one', () => {
    const now = new Date('2026-09-14T08:42:00.000Z');
    for (const offset of [-5, 0, 1, 25]) {
      expect(seedFixTime(anchor, now, offset).getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });
});
