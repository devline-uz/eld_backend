import { coarsenLocation, distanceMi, greatCircleMi } from './location';

describe('units/location', () => {
  it('coarsens on-duty positions to ~1 mile', () => {
    const out = coarsenLocation({ lat: 39.9612, lon: -82.9988 }, 'ONE_MILE');
    expect(distanceMi(out, { lat: 39.9612, lon: -82.9988 })).toBeLessThanOrEqual(1);
  });

  it('coarsens Personal Conveyance positions to ~10 miles', () => {
    const src = { lat: 39.9612, lon: -82.9988 };
    const out = coarsenLocation(src, 'TEN_MILE');
    expect(distanceMi(out, src)).toBeLessThanOrEqual(10);
    expect(out).not.toEqual(src);
  });

  it('does not divide by zero at the poles', () => {
    const out = coarsenLocation({ lat: 90, lon: 12.34 }, 'ONE_MILE');
    expect(Number.isFinite(out.lat)).toBe(true);
    expect(Number.isFinite(out.lon)).toBe(true);
  });

  it('measures distance in whole miles', () => {
    expect(distanceMi({ lat: 0, lon: 0 }, { lat: 0, lon: 0 })).toBe(0);
    // Columbus OH → Cleveland OH ≈ 125 mi
    const d = distanceMi({ lat: 39.9612, lon: -82.9988 }, { lat: 41.4993, lon: -81.6944 });
    expect(d).toBeGreaterThan(115);
    expect(d).toBeLessThan(135);
  });

  it('greatCircleMi keeps the fraction (geo-location lookups)', () => {
    // 0.1 deg of longitude at 40N ~ 5.3 mi
    const d = greatCircleMi({ lat: 40, lon: -83 }, { lat: 40, lon: -82.9 });
    expect(d).toBeGreaterThan(5.2);
    expect(d).toBeLessThan(5.4);
    expect(Number.isInteger(d)).toBe(false);
  });

  it('clamps the haversine root for antipodal points', () => {
    expect(distanceMi({ lat: 0, lon: 0 }, { lat: 0, lon: 180 })).toBeGreaterThan(12000);
  });
});
