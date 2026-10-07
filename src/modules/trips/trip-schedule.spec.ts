import { findScheduleConflict, occupancyOf, windowsOverlap, type ScheduledTripLike } from './trip-schedule';

const at = (h: number) => new Date(Date.UTC(2026, 9, 10, h));
const trip = (o: Partial<ScheduledTripLike> = {}): ScheduledTripLike => ({
  id: 't1',
  number: 'TRP-1',
  status: 'PLANNED',
  plannedStartAt: at(10),
  plannedEndAt: at(14),
  startedAt: null,
  completedAt: null,
  ...o,
});

describe('trip-schedule — windowsOverlap', () => {
  it('detects a partial overlap', () => {
    expect(windowsOverlap({ start: at(12), end: at(16) }, { start: at(10), end: at(14) })).toBe(true);
  });
  it('allows touching endpoints both ways', () => {
    expect(windowsOverlap({ start: at(14), end: at(16) }, { start: at(10), end: at(14) })).toBe(false);
    expect(windowsOverlap({ start: at(6), end: at(10) }, { start: at(10), end: at(14) })).toBe(false);
  });
  it('detects containment', () => {
    expect(windowsOverlap({ start: at(11), end: at(12) }, { start: at(10), end: at(14) })).toBe(true);
    expect(windowsOverlap({ start: at(8), end: at(20) }, { start: at(10), end: at(14) })).toBe(true);
  });
  it('treats a null end as open-ended', () => {
    expect(windowsOverlap({ start: at(100), end: at(101) }, { start: at(10), end: null })).toBe(true);
    expect(windowsOverlap({ start: at(0), end: at(10) }, { start: at(10), end: null })).toBe(false);
    expect(windowsOverlap({ start: at(0), end: null }, { start: at(10), end: at(11) })).toBe(true);
  });
});

describe('trip-schedule — occupancyOf', () => {
  const now = at(20);
  it('counts a DRAFT like a planned trip, ignores CANCELLED', () => {
    expect(occupancyOf(trip({ status: 'DRAFT' }), now)).toEqual({ start: at(10), end: at(14) });
    expect(occupancyOf(trip({ status: 'CANCELLED' }), now)).toBeNull();
  });
  it('ignores a scheduled trip with no planned start', () => {
    expect(occupancyOf(trip({ plannedStartAt: null }), now)).toBeNull();
  });
  it('uses the actual range of a DELIVERED trip', () => {
    expect(occupancyOf(trip({ status: 'DELIVERED', startedAt: at(11), completedAt: at(13) }), now)).toEqual({ start: at(11), end: at(13) });
  });
  it('stretches an overrunning IN_PROGRESS trip to now, and leaves one with no planned end open', () => {
    expect(occupancyOf(trip({ status: 'IN_PROGRESS', startedAt: at(9) }), now)).toEqual({ start: at(9), end: now });
    expect(occupancyOf(trip({ status: 'IN_PROGRESS', startedAt: at(9), plannedEndAt: at(30) }), now)).toEqual({ start: at(9), end: at(30) });
    expect(occupancyOf(trip({ status: 'IN_PROGRESS', startedAt: at(9), plannedEndAt: null }), now)).toEqual({ start: at(9), end: null });
  });
});

describe('trip-schedule — findScheduleConflict', () => {
  it('skips the excluded trip itself', () => {
    expect(findScheduleConflict({ start: at(11), end: at(12) }, [trip({ id: 'self' })], 'self')).toBeNull();
  });
  it('returns the first overlapping trip with its occupied range', () => {
    const hit = findScheduleConflict({ start: at(11), end: at(12) }, [trip({ id: 'a', plannedStartAt: at(0), plannedEndAt: at(5) }), trip({ id: 'b' })]);
    expect(hit?.trip.id).toBe('b');
    expect(hit?.window).toEqual({ start: at(10), end: at(14) });
  });
});
