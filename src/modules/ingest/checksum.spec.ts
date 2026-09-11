import { canonicalString, computeChecksum, verifyChecksum } from './checksum';

const base = {
  uuid: '3f2a-0001',
  eventType: 1,
  eventCode: 3,
  eventDateTime: new Date('2025-09-10T06:30:44.000Z'),
  timezoneOffset: -240,
  recordOrigin: 1,
  latitude: 39.961176,
  longitude: -82.998794,
  rawDeviceOdometerKm: 1598200,
  totalEngineHours: 1070.7,
};

describe('ingest/checksum (TZ §7.3 rule 4, §23)', () => {
  it('is deterministic and 16 hex chars', () => {
    const a = computeChecksum(base);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(computeChecksum({ ...base })).toBe(a);
  });

  it('covers the RAW device values, so corruption on the BLE/HTTP path is detectable', () => {
    expect(computeChecksum({ ...base, rawDeviceOdometerKm: 1598201 })).not.toBe(
      computeChecksum(base),
    );
    expect(computeChecksum({ ...base, latitude: 39.961177 })).not.toBe(computeChecksum(base));
    expect(computeChecksum({ ...base, eventCode: 4 })).not.toBe(computeChecksum(base));
  });

  it('ignores sub-second precision and accepts an ISO string identically to a Date', () => {
    expect(computeChecksum({ ...base, eventDateTime: '2025-09-10T06:30:44Z' })).toBe(
      computeChecksum(base),
    );
  });

  it('canonical string is the documented pipe-joined form', () => {
    expect(canonicalString(base)).toBe(
      '3f2a-0001|1|3|2025-09-10T06:30:44Z|-240|1|1|39.961176|-82.998794|1598200|1070.70',
    );
  });

  it('verifies a matching checksum case-insensitively', () => {
    const supplied = computeChecksum(base).toUpperCase();
    expect(verifyChecksum(base, supplied)).toMatchObject({ ok: true });
  });

  it('flags a mismatch without throwing — the event is still stored (§7.3)', () => {
    const verdict = verifyChecksum(base, 'deadbeefdeadbeef');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('MISMATCH');
    expect(verdict.expected).toBe(computeChecksum(base));
  });

  it('treats an absent checksum as missing data, not as a rejection', () => {
    expect(verifyChecksum(base, undefined)).toMatchObject({ ok: false, reason: 'MISSING' });
    expect(verifyChecksum(base, '   ')).toMatchObject({ ok: false, reason: 'MISSING' });
  });
});
