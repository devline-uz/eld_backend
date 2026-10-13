import { MobileCreateTransferDto } from './mobile-transfers.dto';

describe('MobileCreateTransferDto.requestedAt (B-161)', () => {
  const base = { method: 'WEB_SERVICES', rangeStart: '2026-09-03', rangeEnd: '2026-09-10' };
  it('accepts now and up to 5 min ahead (device clock skew)', () => {
    expect(MobileCreateTransferDto.safeParse({ ...base, requestedAt: new Date().toISOString() }).success).toBe(true);
    expect(MobileCreateTransferDto.safeParse({ ...base, requestedAt: new Date(Date.now() + 4 * 60_000).toISOString() }).success).toBe(true);
  });
  it('rejects a requestedAt more than 5 min in the future', () => {
    expect(MobileCreateTransferDto.safeParse({ ...base, requestedAt: new Date(Date.now() + 10 * 60_000).toISOString() }).success).toBe(false);
  });
});
