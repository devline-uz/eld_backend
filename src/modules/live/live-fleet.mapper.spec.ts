import {
  compareUnitNumbers,
  ELD_OFFLINE_AFTER_MS,
  isEldOffline,
  toLiveFleetUnit,
  type LiveFleetInput,
} from './live-fleet.mapper';

const NOW = new Date('2026-09-14T15:41:00.000Z');
const minsAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);

function input(overrides: Partial<LiveFleetInput> = {}): LiveFleetInput {
  return {
    vehicle: { id: 'veh_1', unitNumber: '101', status: 'ACTIVE', odometerMi: 50_000 },
    driver: { id: 'drv_1', firstName: 'John', lastName: 'Smith', phone: '+1 334 765 4888' },
    device: { serial: 'PT30_A86E', bleState: 'CONNECTED', lastSeenAt: minsAgo(1) },
    telemetry: {
      time: minsAgo(2),
      fixTime: minsAgo(2),
      latitude: 38.99,
      longitude: -84.63,
      speedMph: 61,
      headingDeg: 274,
      odometerMi: 50_120,
      engineOn: true,
    },
    located: null,
    hos: { currentStatus: 'D', driveRemainingSec: 16_200, shiftEndsAt: new Date('2026-09-14T21:10:00.000Z') },
    special: null,
    now: NOW,
    ...overrides,
  };
}

describe('toLiveFleetUnit (GET /live/fleet, web/tz.md §20 B-3)', () => {
  it('PT SDK 6.11 — a newest point without a GPS fix keeps the last located pin and fresh speed', () => {
    const unit = toLiveFleetUnit(
      input({
        telemetry: {
          time: minsAgo(1), fixTime: minsAgo(20), latitude: 38.5, longitude: -84.1,
          speedMph: 55, headingDeg: 90, odometerMi: 50_130, engineOn: true,
        },
      }),
    );
    expect(unit.lat).toBe(38.5);
    expect(unit.lon).toBe(-84.1);
    expect(unit.speedMph).toBe(55);
  });

  it('PT SDK 6.11 — no located point at all yields a null position, never 0/0', () => {
    const unit = toLiveFleetUnit(
      input({
        telemetry: {
          time: minsAgo(1), fixTime: null, latitude: null, longitude: null,
          speedMph: 0, headingDeg: null, odometerMi: null, engineOn: true,
        },
      }),
    );
    expect(unit.lat).toBeNull();
    expect(unit.lon).toBeNull();
  });

  it('emits exactly the fields web/src/shared/api/liveFleet.ts reads', () => {
    const unit = toLiveFleetUnit(input());
    expect(Object.keys(unit).sort()).toEqual(
      [
        'vehicleId', 'unitNumber', 'driverId', 'driverName', 'driverPhone', 'dutyStatus', 'speedMph',
        'headingDeg', 'odometerMi', 'lat', 'lon', 'locationLabel', 'lastSeenAt', 'driveRemainingSec',
        'shiftEndsAt', 'eldSerial', 'bleState',
      ].sort(),
    );
    expect(unit).toMatchObject({
      vehicleId: 'veh_1',
      unitNumber: '101',
      driverId: 'drv_1',
      driverName: 'John Smith',
      dutyStatus: 'DRIVING',
      speedMph: 61,
      headingDeg: 274,
      odometerMi: 50_120,
      lat: 38.99,
      lon: -84.63,
      lastSeenAt: minsAgo(1).toISOString(),
      driveRemainingSec: 16_200,
      shiftEndsAt: '2026-09-14T21:10:00.000Z',
      eldSerial: 'PT30_A86E',
      bleState: 'CONNECTED',
    });
  });

  it.each([
    ['OFF', 'OFF_DUTY'],
    ['SB', 'SLEEPER'],
    ['D', 'DRIVING'],
  ] as const)('maps HOS %s to %s', (hosStatus, expected) => {
    const unit = toLiveFleetUnit(input({ hos: { currentStatus: hosStatus, driveRemainingSec: 1, shiftEndsAt: null } }));
    expect(unit.dutyStatus).toBe(expected);
    expect(unit.shiftEndsAt).toBeNull();
  });

  it('ON duty with the engine running and the truck stopped reads IDLE; moving reads ON_DUTY', () => {
    const hos = { currentStatus: 'ON' as const, driveRemainingSec: 0, shiftEndsAt: null };
    const base = input({ hos });
    expect(toLiveFleetUnit({ ...base, telemetry: { ...base.telemetry!, speedMph: 0 } }).dutyStatus).toBe('IDLE');
    expect(toLiveFleetUnit(base).dutyStatus).toBe('ON_DUTY');
    // A stale fix cannot prove the engine is still idling.
    expect(
      toLiveFleetUnit({ ...base, telemetry: { ...base.telemetry!, speedMph: 0, time: minsAgo(45) } }).dutyStatus,
    ).toBe('ON_DUTY');
  });

  it('shows an active PC/YM indication only on the duty status that can carry it', () => {
    const off = { currentStatus: 'OFF' as const, driveRemainingSec: 0, shiftEndsAt: null };
    const on = { currentStatus: 'ON' as const, driveRemainingSec: 0, shiftEndsAt: null };
    expect(toLiveFleetUnit(input({ hos: off, special: 'PC' })).dutyStatus).toBe('PERSONAL_CONVEYANCE');
    expect(toLiveFleetUnit(input({ hos: on, special: 'YM' })).dutyStatus).toBe('YARD_MOVE');
    expect(toLiveFleetUnit(input({ hos: on, special: 'PC' })).dutyStatus).toBe('ON_DUTY');
  });

  it('a unit without a driver is ELD_OFFLINE after 30 min unseen, OFF_DUTY while its ELD is alive, INACTIVE with no ELD', () => {
    const noDriver = { driver: null, hos: null };
    const stale = toLiveFleetUnit(
      input({ ...noDriver, device: { serial: 'PT30_9931', bleState: 'OUT_OF_RANGE', lastSeenAt: minsAgo(31) } }),
    );
    expect(stale).toMatchObject({ dutyStatus: 'ELD_OFFLINE', bleState: 'DISCONNECTED', driverName: null, driveRemainingSec: null });
    expect(toLiveFleetUnit(input(noDriver)).dutyStatus).toBe('OFF_DUTY');
    expect(toLiveFleetUnit(input({ ...noDriver, device: null })).dutyStatus).toBe('INACTIVE');
    expect(
      toLiveFleetUnit(input({ ...noDriver, vehicle: { id: 'v', unitNumber: '110', status: 'OUT_OF_SERVICE', odometerMi: 1 } }))
        .dutyStatus,
    ).toBe('INACTIVE');
  });

  it('never reports a device as CONNECTED once its heartbeat is older than 30 min, and maps OUT_OF_RANGE to DISCONNECTED', () => {
    expect(toLiveFleetUnit(input({ device: { serial: 's', bleState: 'CONNECTED', lastSeenAt: minsAgo(40) } })).bleState).toBe('DISCONNECTED');
    expect(toLiveFleetUnit(input({ device: { serial: 's', bleState: 'OUT_OF_RANGE', lastSeenAt: minsAgo(1) } })).bleState).toBe('DISCONNECTED');
    expect(toLiveFleetUnit(input({ device: null })).bleState).toBeNull();
  });

  it('drops a stale speed, keeps the vehicle odometer when there is no telemetry, and has no position without any fix', () => {
    const stale = toLiveFleetUnit(input({ telemetry: { ...input().telemetry!, time: minsAgo(31), fixTime: minsAgo(31) } }));
    expect(stale.speedMph).toBeNull();
    expect(stale.lat).toBe(38.99);
    const none = toLiveFleetUnit(input({ telemetry: null }));
    expect(none).toMatchObject({ lat: null, lon: null, speedMph: null, headingDeg: null, odometerMi: 50_000, locationLabel: null });
  });

  it('takes the position (and its place name) from a located RODS record newer than the last telemetry fix', () => {
    const unit = toLiveFleetUnit(
      input({
        telemetry: { ...input().telemetry!, time: minsAgo(90), fixTime: minsAgo(90) },
        located: { eventDateTime: minsAgo(5), latitude: 39.1, longitude: -84.5, locationName: '0.64 mi N of Florence, KY' },
        device: { serial: 's', bleState: 'CONNECTED', lastSeenAt: minsAgo(120) },
      }),
    );
    expect(unit).toMatchObject({ lat: 39.1, lon: -84.5, locationLabel: '0.64 mi N of Florence, KY', lastSeenAt: minsAgo(5).toISOString() });
  });

  it('does not attach an old place name to a much newer telemetry fix', () => {
    const unit = toLiveFleetUnit(
      input({ located: { eventDateTime: minsAgo(300), latitude: 1, longitude: 1, locationName: 'Somewhere old' } }),
    );
    expect(unit.lat).toBe(38.99);
    expect(unit.locationLabel).toBeNull();
    const near = toLiveFleetUnit(input({ located: { eventDateTime: minsAgo(10), latitude: 1, longitude: 1, locationName: 'Near' } }));
    expect(near.locationLabel).toBe('Near');
  });

  it('isEldOffline treats a never-seen device as offline and no device as not offline', () => {
    expect(isEldOffline({ serial: 's', bleState: 'CONNECTED', lastSeenAt: null }, NOW)).toBe(true);
    expect(isEldOffline({ serial: 's', bleState: 'CONNECTED', lastSeenAt: new Date(NOW.getTime() - ELD_OFFLINE_AFTER_MS) }, NOW)).toBe(false);
    expect(isEldOffline(null, NOW)).toBe(false);
  });

  it('orders unit numbers naturally', () => {
    expect(['110', '9', '101'].sort(compareUnitNumbers)).toEqual(['9', '101', '110']);
  });
});
