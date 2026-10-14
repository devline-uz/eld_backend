import { ruleEventsFor } from './alert-events';

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
