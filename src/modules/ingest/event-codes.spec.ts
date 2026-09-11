import { EVENT_SEQUENCE_MAX, EVENT_SEQUENCE_MIN, nextSequenceId } from './event-codes';

describe('ingest/event-codes — Appendix A sequence (§5.5)', () => {
  it('starts at 1 and increases monotonically', () => {
    expect(nextSequenceId(0)).toBe(1);
    expect(nextSequenceId(1)).toBe(2);
    expect(nextSequenceId(65534)).toBe(EVENT_SEQUENCE_MAX);
  });

  it('wraps 65535 → 1', () => {
    expect(nextSequenceId(EVENT_SEQUENCE_MAX)).toBe(EVENT_SEQUENCE_MIN);
  });

  it('is defensive about impossible stored values', () => {
    expect(nextSequenceId(-5)).toBe(1);
    expect(nextSequenceId(Number.NaN)).toBe(1);
    expect(nextSequenceId(99999)).toBe(1);
  });
});
