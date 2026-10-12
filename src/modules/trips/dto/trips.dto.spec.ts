import { CreateTripDto, UpdateTripDto } from './trips.dto';

const base = { number: 'TRP-1' };
const stop = (sequence: number, type: string, scheduledAt?: string) => ({ sequence, type, name: `Stop ${sequence}`, ...(scheduledAt && { scheduledAt }) });
const paths = (input: unknown) => {
  const r = CreateTripDto.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('CreateTripDto — stops (BE-018)', () => {
  it('accepts the web form shape: pickup, untimed intermediate stop, delivery, no coordinates', () => {
    const stops = [stop(1, 'PICKUP', '2026-10-20T10:00:00Z'), stop(2, 'CHECKPOINT'), stop(3, 'DELIVERY', '2026-10-21T10:00:00Z')];
    expect(CreateTripDto.safeParse({ ...base, stops }).success).toBe(true);
  });

  it('rejects duplicate sequence numbers', () => {
    expect(paths({ ...base, stops: [stop(1, 'PICKUP'), stop(1, 'DELIVERY')] })).toEqual(['stops.1.sequence']);
  });

  it('rejects a delivery scheduled before the pickup', () => {
    const stops = [stop(1, 'PICKUP', '2026-10-21T10:00:00Z'), stop(2, 'DELIVERY', '2026-10-20T10:00:00Z')];
    expect(paths({ ...base, stops })).toEqual(['stops.1.scheduledAt']);
  });

  it('rejects a delivery sequenced before the first pickup', () => {
    expect(paths({ ...base, stops: [stop(2, 'PICKUP'), stop(1, 'DELIVERY')] })).toEqual(['stops.1.sequence']);
  });
});

describe('CreateTripDto / UpdateTripDto — INT4 bounds (BE-008) and trimming (BE-015)', () => {
  it('rejects weight / pieces / drive seconds beyond INT4-safe limits', () => {
    expect(paths({ ...base, weightLbs: 2_147_483_648 })).toEqual(['weightLbs']);
    expect(paths({ ...base, pieces: 99_999_999_999 })).toEqual(['pieces']);
    expect(paths({ ...base, estimatedDriveSec: 3_000_000_000 })).toEqual(['estimatedDriveSec']);
    expect(UpdateTripDto.safeParse({ weightLbs: 2_147_483_648 }).success).toBe(false);
    expect(UpdateTripDto.safeParse({ weightLbs: 80_000, pieces: 24 }).success).toBe(true);
  });

  it('trims the trip number and rejects a whitespace-only one', () => {
    expect(CreateTripDto.parse({ number: '  TRP-9  ' }).number).toBe('TRP-9');
    expect(paths({ number: '   ' })).toEqual(['number']);
    expect(paths({ ...base, stops: [{ sequence: 1, type: 'PICKUP', name: '  ' }] })).toEqual(['stops.0.name']);
  });
});
