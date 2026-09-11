import { computeDriverScore, detectHarshEvents, HARSH_SPEED_DELTA_MPH, toSample } from './harsh-detect';

function sample(time: string, speedMph: number | null, headingDeg: number | null = 0) {
  return { time: new Date(time), speedMph, headingDeg, latitude: 40, longitude: -83 };
}

describe('detectHarshEvents — braking / acceleration', () => {
  it('flags harsh braking exactly AT the threshold (boundary, inclusive)', () => {
    const samples = [sample('2026-09-11T00:00:00.000Z', 50), sample('2026-09-11T00:00:01.000Z', 50 - HARSH_SPEED_DELTA_MPH)];
    const events = detectHarshEvents(samples);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('HARSH_BRAKING');
  });

  it('does not flag one mph under the threshold', () => {
    const samples = [sample('2026-09-11T00:00:00.000Z', 50), sample('2026-09-11T00:00:01.000Z', 50 - (HARSH_SPEED_DELTA_MPH - 1))];
    expect(detectHarshEvents(samples)).toHaveLength(0);
  });

  it('flags harsh acceleration symmetrically', () => {
    const samples = [sample('2026-09-11T00:00:00.000Z', 20), sample('2026-09-11T00:00:01.000Z', 20 + HARSH_SPEED_DELTA_MPH)];
    const events = detectHarshEvents(samples);
    expect(events[0].type).toBe('HARSH_ACCEL');
  });

  it('ignores a delta spread over more than the 2s window', () => {
    const samples = [sample('2026-09-11T00:00:00.000Z', 50), sample('2026-09-11T00:00:05.000Z', 30)];
    expect(detectHarshEvents(samples)).toHaveLength(0);
  });

  it('ignores null speed samples', () => {
    const samples = [sample('2026-09-11T00:00:00.000Z', null), sample('2026-09-11T00:00:01.000Z', 10)];
    expect(detectHarshEvents(samples)).toHaveLength(0);
  });

  it('is reproducible — same input always yields the same output', () => {
    const samples = [sample('2026-09-11T00:00:00.000Z', 50), sample('2026-09-11T00:00:01.000Z', 40)];
    expect(detectHarshEvents(samples)).toEqual(detectHarshEvents(samples));
  });
});

describe('detectHarshEvents — turns', () => {
  it('flags a sharp turn above the min speed', () => {
    const samples = [sample('2026-09-11T00:00:00.000Z', 20, 0), sample('2026-09-11T00:00:01.000Z', 20, 50)];
    const events = detectHarshEvents(samples);
    expect(events[0].type).toBe('HARSH_TURN');
  });

  it('does not flag a sharp turn below the min speed', () => {
    const samples = [sample('2026-09-11T00:00:00.000Z', 5, 0), sample('2026-09-11T00:00:01.000Z', 5, 50)];
    expect(detectHarshEvents(samples)).toHaveLength(0);
  });

  it('handles heading wraparound (350 -> 10 is a 20deg turn, not 340)', () => {
    const samples = [sample('2026-09-11T00:00:00.000Z', 20, 350), sample('2026-09-11T00:00:01.000Z', 20, 10)];
    expect(detectHarshEvents(samples)).toHaveLength(0);
  });
});

describe('toSample', () => {
  it('converts km/h to whole mph', () => {
    const s = toSample({ time: new Date(), speedKmh: 100, headingDeg: 90, latitude: 1, longitude: 2 });
    expect(s.speedMph).toBe(Math.round(100 * 0.621371));
  });
});

describe('computeDriverScore', () => {
  it('returns 100 for a perfectly clean driver', () => {
    expect(computeDriverScore({ harshCount: 0, speedingCount: 0, milesDriven: 1000, violationCount: 0 })).toBe(100);
  });

  it('is bounded at 0 for a very poor record', () => {
    expect(computeDriverScore({ harshCount: 500, speedingCount: 500, milesDriven: 100, violationCount: 50 })).toBe(0);
  });

  it('does not divide by zero for a driver with no recorded miles', () => {
    expect(() => computeDriverScore({ harshCount: 1, speedingCount: 0, milesDriven: 0, violationCount: 0 })).not.toThrow();
  });

  it('is deterministic', () => {
    const input = { harshCount: 3, speedingCount: 2, milesDriven: 5000, violationCount: 1 };
    expect(computeDriverScore(input)).toBe(computeDriverScore(input));
  });
});
