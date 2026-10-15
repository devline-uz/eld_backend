import { EVENT_SEQUENCE_MAX, EVENT_SEQUENCE_MIN, ingestRecordOrigin, isAutomaticDeviceEvent, nextSequenceId } from './event-codes';

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

describe('ingest/event-codes — server-derived recordOrigin (B-181 / D-165, App. A 7.22)', () => {
  it('automatic device events are always origin 1, whatever the client claims', () => {
    for (const claimed of [1, 2, 3, 4]) {
      expect(ingestRecordOrigin(1, 3, claimed)).toBe(1);
      expect(ingestRecordOrigin(2, 1, claimed)).toBe(1);
      expect(ingestRecordOrigin(6, 3, claimed)).toBe(1);
      expect(ingestRecordOrigin(7, 1, claimed)).toBe(1);
    }
  });

  it('driver-selectable types keep 1 or 2; 3 and 4 become 2', () => {
    expect(ingestRecordOrigin(1, 4, 1)).toBe(1);
    expect(ingestRecordOrigin(1, 1, 2)).toBe(2);
    expect(ingestRecordOrigin(3, 1, 3)).toBe(2);
    expect(ingestRecordOrigin(5, 1, 4)).toBe(2);
    expect(ingestRecordOrigin(4, 1, 2)).toBe(2);
  });

  it('classifies automatic events', () => {
    expect(isAutomaticDeviceEvent(1, 3)).toBe(true);
    expect(isAutomaticDeviceEvent(1, 4)).toBe(false);
    expect(isAutomaticDeviceEvent(3, 1)).toBe(false);
    expect(isAutomaticDeviceEvent(5, 1)).toBe(false);
  });
});
