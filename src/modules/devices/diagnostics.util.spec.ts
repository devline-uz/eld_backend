import { deriveDeviceDiagnostics } from './diagnostics.util';

const NOW = new Date('2026-09-24T12:00:00.000Z');

describe('deriveDeviceDiagnostics (B-8)', () => {
  it('is responded:false, not an error, when the device has never reported', () => {
    const result = deriveDeviceDiagnostics({ bleState: 'DISCONNECTED', lastSeenAt: null }, NOW);
    expect(result).toEqual({ signalStrength: 'poor', gpsLock: false, responded: false });
  });

  it('is responded:false when the device has gone quiet beyond the timeout, even if bleState says CONNECTED', () => {
    const staleLastSeen = new Date(NOW.getTime() - 30 * 60 * 1000);
    const result = deriveDeviceDiagnostics({ bleState: 'CONNECTED', lastSeenAt: staleLastSeen }, NOW);
    expect(result.responded).toBe(false);
  });

  it('reads good signal + GPS lock for a freshly-connected device', () => {
    const lastSeen = new Date(NOW.getTime() - 30 * 1000);
    const result = deriveDeviceDiagnostics({ bleState: 'CONNECTED', lastSeenAt: lastSeen }, NOW);
    expect(result).toEqual({ signalStrength: 'good', gpsLock: true, responded: true });
  });

  it('reads fair signal for a connected device whose last report is a bit stale', () => {
    const lastSeen = new Date(NOW.getTime() - 5 * 60 * 1000);
    const result = deriveDeviceDiagnostics({ bleState: 'CONNECTED', lastSeenAt: lastSeen }, NOW);
    expect(result.signalStrength).toBe('fair');
    expect(result.responded).toBe(true);
  });

  it('reads poor signal and no GPS lock for OUT_OF_RANGE, but still responded', () => {
    const lastSeen = new Date(NOW.getTime() - 30 * 1000);
    const result = deriveDeviceDiagnostics({ bleState: 'OUT_OF_RANGE', lastSeenAt: lastSeen }, NOW);
    expect(result).toEqual({ signalStrength: 'poor', gpsLock: false, responded: true });
  });
});
