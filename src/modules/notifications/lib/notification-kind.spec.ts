import { NotificationKind } from '@prisma/client';
import { deriveNotificationBody, deriveNotificationCategory, deriveNotificationKind, deriveObjectRef } from './notification-kind';

describe('deriveNotificationKind', () => {
  it.each([
    ['alert.hos_violation', NotificationKind.VIOLATION],
    ['alert.break_required', NotificationKind.WARNING],
    ['alert.edit_request', NotificationKind.EDIT_REQUEST],
    ['message.new', NotificationKind.MESSAGE],
    ['alert.trip_assigned', NotificationKind.TRIP],
    ['alert.unidentified_driving', NotificationKind.UNIDENTIFIED],
    ['alert.uncertified_logs', NotificationKind.CERTIFY],
    ['alert.maintenance_due', NotificationKind.MAINTENANCE],
    ['alert.eld_disconnected', NotificationKind.DEVICE],
    ['alert.device_backlog', NotificationKind.DEVICE],
    ['alert.odometer_anomaly', NotificationKind.OTHER],
  ])('%s -> %s', (event, expected) => {
    expect(deriveNotificationKind(event)).toBe(expected);
  });
});

describe('deriveObjectRef', () => {
  it('resolves EldEvent for alert.edit_request', () => {
    expect(deriveObjectRef('alert.edit_request', { requestId: 'evt_1' })).toEqual({
      objectType: 'EldEvent',
      objectId: 'evt_1',
    });
  });

  it('resolves Trip for alert.trip_assigned', () => {
    expect(deriveObjectRef('alert.trip_assigned', { tripId: 'trip_1' })).toEqual({
      objectType: 'Trip',
      objectId: 'trip_1',
    });
  });

  it('resolves UnidentifiedSegment when segmentId is present, else falls back to Vehicle', () => {
    expect(deriveObjectRef('alert.unidentified_driving', { segmentId: 'seg_1' })).toEqual({
      objectType: 'UnidentifiedSegment',
      objectId: 'seg_1',
    });
    expect(deriveObjectRef('alert.unidentified_confirmation_requested', { vehicleId: 'veh_1' })).toEqual({
      objectType: 'Vehicle',
      objectId: 'veh_1',
    });
  });

  it('resolves Device for alert.eld_* / alert.device_*', () => {
    expect(deriveObjectRef('alert.eld_disconnected', { deviceSerial: 'PT30-1' })).toEqual({
      objectType: 'Device',
      objectId: 'PT30-1',
    });
  });

  it('returns undefined when the payload has no identifiable subject', () => {
    expect(deriveObjectRef('alert.unknown_event', {})).toBeUndefined();
  });
});

describe('deriveNotificationCategory (§20 B-57)', () => {
  it.each([
    [NotificationKind.VIOLATION, 'VIOLATIONS'],
    [NotificationKind.WARNING, 'VIOLATIONS'],
    [NotificationKind.CERTIFY, 'VIOLATIONS'],
    [NotificationKind.UNIDENTIFIED, 'VIOLATIONS'],
    [NotificationKind.MAINTENANCE, 'MAINTENANCE'],
    [NotificationKind.DEVICE, 'MAINTENANCE'],
    [NotificationKind.EDIT_REQUEST, undefined],
    [NotificationKind.MESSAGE, undefined],
    [NotificationKind.TRIP, undefined],
    [NotificationKind.OTHER, undefined],
  ])('%s -> %s', (kind, expected) => {
    expect(deriveNotificationCategory(kind)).toBe(expected);
  });
});

describe('deriveNotificationBody (§20 B-58)', () => {
  it('prefers an explicit payload.message when present', () => {
    expect(deriveNotificationBody('alert.custom', { message: 'Custom text.' })).toBe('Custom text.');
  });

  it('returns a human sentence for known events', () => {
    expect(deriveNotificationBody('alert.hos_violation', {})).toBe('An HOS violation was detected.');
    expect(deriveNotificationBody('alert.trip_assigned', {})).toBe('A new trip was assigned.');
    expect(deriveNotificationBody('alert.eld_disconnected', {})).toBe('An ELD device disconnected.');
  });

  it('never returns raw JSON, even for an unknown event', () => {
    const body = deriveNotificationBody('alert.some_future_event', { foo: 'bar' });
    expect(body).not.toContain('{');
    expect(body.length).toBeGreaterThan(0);
  });
});
