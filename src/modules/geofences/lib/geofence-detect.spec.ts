import { detectGeofenceTransitions, isInsideGeofence } from './geofence-detect';

const fence = {
  id: 'gf_1',
  centerLat: 40.0,
  centerLon: -83.0,
  radiusMi: 1,
  alertOnEnter: true,
  alertOnExit: true,
};

describe('isInsideGeofence', () => {
  it('is inside at the exact center', () => {
    expect(isInsideGeofence({ lat: 40.0, lon: -83.0 }, fence)).toBe(true);
  });

  it('is inside exactly AT the radius boundary (inclusive)', () => {
    // ~1 mile north: 1 / 69.0 deg latitude.
    const point = { lat: 40.0 + 1 / 69.0, lon: -83.0 };
    expect(isInsideGeofence(point, fence)).toBe(true);
  });

  it('is outside well past the radius', () => {
    expect(isInsideGeofence({ lat: 41.0, lon: -83.0 }, fence)).toBe(false);
  });
});

describe('detectGeofenceTransitions', () => {
  it('produces no transition when the vehicle stays inside', () => {
    const points = [{ lat: 40.0, lon: -83.0 }, { lat: 40.001, lon: -83.0 }];
    expect(detectGeofenceTransitions(points, fence, true)).toEqual([]);
  });

  it('produces ENTER when crossing from outside to inside', () => {
    const points = [{ lat: 41.0, lon: -83.0 }, { lat: 40.0, lon: -83.0 }];
    expect(detectGeofenceTransitions(points, fence, false)).toEqual([{ geofenceId: 'gf_1', kind: 'ENTER' }]);
  });

  it('produces EXIT when crossing from inside to outside', () => {
    const points = [{ lat: 40.0, lon: -83.0 }, { lat: 41.0, lon: -83.0 }];
    expect(detectGeofenceTransitions(points, fence, true)).toEqual([{ geofenceId: 'gf_1', kind: 'EXIT' }]);
  });

  it('collapses multiple crossings in one batch to the net transition', () => {
    const points = [
      { lat: 41.0, lon: -83.0 }, // outside
      { lat: 40.0, lon: -83.0 }, // inside -> ENTER
      { lat: 41.0, lon: -83.0 }, // outside -> EXIT (replaces ENTER as the latest of that kind)
    ];
    const result = detectGeofenceTransitions(points, fence, false);
    expect(result).toEqual([{ geofenceId: 'gf_1', kind: 'EXIT' }]);
  });

  it('establishes baseline without emitting when there is no prior point (wasInside=null)', () => {
    const points = [{ lat: 40.0, lon: -83.0 }, { lat: 41.0, lon: -83.0 }];
    // First point only sets the baseline; the exit from point 1->2 still fires.
    expect(detectGeofenceTransitions(points, fence, null)).toEqual([{ geofenceId: 'gf_1', kind: 'EXIT' }]);
  });

  it('respects alertOnEnter/alertOnExit flags independently', () => {
    const enterOnly = { ...fence, alertOnExit: false };
    const points = [{ lat: 41.0, lon: -83.0 }, { lat: 40.0, lon: -83.0 }, { lat: 41.0, lon: -83.0 }];
    expect(detectGeofenceTransitions(points, enterOnly, false)).toEqual([{ geofenceId: 'gf_1', kind: 'ENTER' }]);
  });

  it('returns nothing for a disabled-alert fence', () => {
    const silent = { ...fence, alertOnEnter: false, alertOnExit: false };
    const points = [{ lat: 41.0, lon: -83.0 }, { lat: 40.0, lon: -83.0 }];
    expect(detectGeofenceTransitions(points, silent, false)).toEqual([]);
  });
});
