import { computeDriverScore, detectHarshEvents, HARSH_SPEED_DELTA_MPH, severityFactor, toSample } from './harsh-detect';

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

describe('computeDriverScore (D-141)', () => {
  const base = { harsh: [], speedingCount: 0, seatbeltCount: 0, violationCount: 0, milesDriven: 1000 };

  it('returns 100 for a perfectly clean driver', () => {
    expect(computeDriverScore(base)).toBe(100);
  });

  it.each([
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 4],
    [5, 4],
    [0, 1], // clamped into 1–5
    [9, 4],
  ])('severity %d has factor %d', (severity, factor) => {
    expect(severityFactor(severity)).toBe(factor);
    // One harsh event over exactly 1,000 mi deducts 2 × factor.
    expect(computeDriverScore({ ...base, harsh: [{ severity, count: 1 }] })).toBe(100 - 2 * factor);
  });

  it('weights speeding 1.5, seatbelt 3 and HOS violations 5 per 1,000 mi', () => {
    expect(computeDriverScore({ ...base, speedingCount: 2 })).toBe(97);
    expect(computeDriverScore({ ...base, seatbeltCount: 1 })).toBe(97);
    expect(computeDriverScore({ ...base, violationCount: 1 })).toBe(95);
  });

  it('normalises per 1,000 miles and rounds', () => {
    // (2×1 + 2×4 + 1.5 + 3 + 5) = 19.5 points over 2,000 mi = 9.75 -> 90.25 -> 90
    expect(
      computeDriverScore({
        harsh: [
          { severity: 2, count: 1 },
          { severity: 5, count: 1 },
        ],
        speedingCount: 1,
        seatbeltCount: 1,
        violationCount: 1,
        milesDriven: 2000,
      }),
    ).toBe(90);
  });

  it('returns null below 100 miles and scores from exactly 100 miles', () => {
    expect(computeDriverScore({ ...base, milesDriven: 99 })).toBeNull();
    expect(computeDriverScore({ ...base, milesDriven: 0 })).toBeNull();
    expect(computeDriverScore({ ...base, milesDriven: 100 })).toBe(100);
    // 1 violation over 100 mi = 50 points
    expect(computeDriverScore({ ...base, milesDriven: 100, violationCount: 1 })).toBe(50);
  });

  it('is clamped at 0 for a very poor record', () => {
    expect(computeDriverScore({ ...base, milesDriven: 100, violationCount: 50 })).toBe(0);
  });

  it('is deterministic', () => {
    const input = { ...base, harsh: [{ severity: 3, count: 3 }], speedingCount: 2, milesDriven: 5000, violationCount: 1 };
    expect(computeDriverScore(input)).toBe(computeDriverScore(input));
  });
});
