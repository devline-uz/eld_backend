import { breakDueEpisode, conditionParamsMatch, ruleEventsFor } from './alert-events';

describe('ruleEventsFor (LIVE-027 — editor rules match the worker job names)', () => {
  it('keeps the job name itself (system rules are keyed on it)', () => {
    expect(ruleEventsFor('alert.eld_status_stale')).toEqual(['alert.eld_status_stale']);
  });

  it.each([
    ['alert.hos_violation', 'hos.violation'],
    ['alert.harsh_event', 'safety.harsh'],
    ['alert.geofence_exit', 'geofence.exit'],
    ['alert.eld_disconnected', 'device.offline'],
    ['alert.unidentified_driving', 'unidentified.created'],
    ['alert.break_required', 'hos.break_due'],
  ])('%s also matches %s', (job, event) => {
    expect(ruleEventsFor(job)).toEqual([job, event]);
  });

  it('maintenance: only an OVERDUE sweep row matches "Maintenance is overdue"', () => {
    expect(ruleEventsFor('alert.maintenance_due', { state: 'OVERDUE' })).toContain('maintenance.overdue');
    expect(ruleEventsFor('alert.maintenance_due', { state: 'DUE_SOON' })).toEqual(['alert.maintenance_due']);
  });

  it('a geofence enter is not an exit', () => {
    expect(ruleEventsFor('alert.geofence_enter')).toEqual(['alert.geofence_enter']);
  });
});

describe('conditionParamsMatch (editor `params.minutes`)', () => {
  const now = new Date('2026-10-14T12:00:00Z');

  it('break due "within 30": matches every step at or under 30 (the processor dedupes per break)', () => {
    const rule = { event: 'hos.break_due', params: { minutes: 30 } };
    expect(conditionParamsMatch(rule, { minutesUntilBreak: 30 }, now)).toBe(true);
    expect(conditionParamsMatch(rule, { minutesUntilBreak: 28 }, now)).toBe(true);
    expect(conditionParamsMatch(rule, { minutesUntilBreak: 31 }, now)).toBe(false);
    expect(conditionParamsMatch(rule, { minutesUntilBreak: 45 }, now)).toBe(false);
  });

  it('BE-12 — samples straddling the 5-minute window (31 min, then 25 min) still match', () => {
    const rule = { event: 'hos.break_due', params: { minutes: 30 } };
    expect(conditionParamsMatch(rule, { minutesUntilBreak: 31 }, now)).toBe(false);
    expect(conditionParamsMatch(rule, { minutesUntilBreak: 25 }, now)).toBe(true);
    expect(conditionParamsMatch(rule, { minutesUntilBreak: 23 }, now)).toBe(true);
  });

  it('break due without minutes means within 30', () => {
    expect(conditionParamsMatch({ event: 'hos.break_due' }, { minutesUntilBreak: 26 }, now)).toBe(true);
    expect(conditionParamsMatch({ event: 'hos.break_due' }, { minutesUntilBreak: 15 }, now)).toBe(true);
    expect(conditionParamsMatch({ event: 'hos.break_due' }, { minutesUntilBreak: 35 }, now)).toBe(false);
  });

  it('breakDueEpisode keys a break-due job on (driver, deadline); null for other jobs', () => {
    const payload = { driverId: 'drv_1', nextBreakDueAt: '2025-01-15T03:00:00.000Z', minutesUntilBreak: 25 };
    expect(breakDueEpisode('alert.break_due', payload)).toEqual({ driverId: 'drv_1', nextBreakDueAt: '2025-01-15T03:00:00.000Z' });
    expect(breakDueEpisode('alert.hos_violation', payload)).toBeNull();
    expect(breakDueEpisode('alert.break_due', { driverId: 'drv_1' })).toBeNull();
  });

  it('device offline "for 60": compares lastSeenAt with now', () => {
    const rule = { event: 'device.offline', params: { minutes: 60 } };
    expect(conditionParamsMatch(rule, { lastSeenAt: '2026-10-14T10:30:00Z' }, now)).toBe(true);
    expect(conditionParamsMatch(rule, { lastSeenAt: '2026-10-14T11:30:00Z' }, now)).toBe(false);
  });

  it('unassigned driving "longer than 15": uses durationSec when the payload has it', () => {
    const rule = { event: 'unidentified.created', params: { minutes: 15 } };
    expect(conditionParamsMatch(rule, { durationSec: 1200 }, now)).toBe(true);
    expect(conditionParamsMatch(rule, { durationSec: 600 }, now)).toBe(false);
    expect(conditionParamsMatch(rule, { segmentId: 's1' }, now)).toBe(true);
  });

  it('events without thresholds always match', () => {
    expect(conditionParamsMatch({ event: 'hos.violation' }, {}, now)).toBe(true);
  });
});
