import { gapSeconds } from './ingest.repository';

describe('ingest/gapSeconds — §7.8 E/L window arithmetic', () => {
  const from = new Date('2025-09-10T00:00:00Z');
  const to = new Date('2025-09-10T01:00:00Z');

  it('an empty series means the whole window is a gap', () => {
    expect(gapSeconds([], from, to)).toBe(3600);
  });

  it('a steady 60 s cadence produces no gap', () => {
    const samples = Array.from({ length: 60 }, (_, i) => new Date(from.getTime() + i * 60_000));
    expect(gapSeconds(samples, from, to)).toBe(0);
  });

  it('counts a mid-window outage', () => {
    const samples = [from, new Date('2025-09-10T00:40:00Z')];
    expect(gapSeconds(samples, from, to)).toBe(2400 + 1200);
  });

  it('ignores jitter below the 5-minute tolerance', () => {
    const samples = [from, new Date('2025-09-10T00:04:00Z'), new Date('2025-09-10T00:08:00Z')];
    expect(gapSeconds(samples, from, new Date('2025-09-10T00:10:00Z'))).toBe(0);
  });
});
