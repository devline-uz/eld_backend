import { verifyWebhookSignature } from '../../../src/modules/webhooks/lib/webhook-signature';
import { decryptValue } from '../../../src/modules/integrations/lib/secret-cipher';
import {
  computeWebhookSignature,
  encryptSecretFields,
  groupSegmentsByVehicleDay,
  planFillEvents,
  type IftaSegmentLite,
} from './reports';

const KEY = Buffer.from('ZGV2LW9ubHktMzItYnl0ZS1rZXktY2hhbmdlLW1lISE=', 'base64');

describe('reports mock helpers — groupSegmentsByVehicleDay', () => {
  it('sums same-day, multi-jurisdiction segments and picks the highest-mileage jurisdiction as dominant', () => {
    const segments: IftaSegmentLite[] = [
      { vehicleId: 'v1', driverId: 'd1', jurisdiction: 'OH', date: new Date('2026-04-01T00:00:00Z'), distanceMi: 120 },
      { vehicleId: 'v1', driverId: null, jurisdiction: 'IN', date: new Date('2026-04-01T00:00:00Z'), distanceMi: 340 },
      { vehicleId: 'v1', driverId: 'd1', jurisdiction: 'IL', date: new Date('2026-04-02T00:00:00Z'), distanceMi: 200 },
    ];
    const grouped = groupSegmentsByVehicleDay(segments);
    const day1 = grouped.get('v1')!.get('2026-04-01')!;
    expect(day1.miles).toBe(460);
    expect(day1.jurisdiction).toBe('IN'); // 340 > 120
    expect(day1.driverId).toBe('d1'); // filled in from the OH row despite IN being null
    const day2 = grouped.get('v1')!.get('2026-04-02')!;
    expect(day2.miles).toBe(200);
  });

  it('keeps separate vehicles independent', () => {
    const segments: IftaSegmentLite[] = [
      { vehicleId: 'v1', driverId: 'd1', jurisdiction: 'OH', date: new Date('2026-04-01T00:00:00Z'), distanceMi: 100 },
      { vehicleId: 'v2', driverId: 'd2', jurisdiction: 'TX', date: new Date('2026-04-01T00:00:00Z'), distanceMi: 500 },
    ];
    const grouped = groupSegmentsByVehicleDay(segments);
    expect(grouped.size).toBe(2);
    expect(grouped.get('v2')!.get('2026-04-01')!.miles).toBe(500);
  });
});

describe('reports mock helpers — planFillEvents', () => {
  it('places a fill only once cumulative mileage crosses the threshold, then resets the counter', () => {
    const days: Array<[string, { miles: number; jurisdiction: string; jMiles: number; driverId: string | null }]> = [
      ['2026-04-01', { miles: 300, jurisdiction: 'OH', jMiles: 300, driverId: 'd1' }],
      ['2026-04-02', { miles: 300, jurisdiction: 'IN', jMiles: 300, driverId: 'd1' }],
      ['2026-04-03', { miles: 300, jurisdiction: 'IL', jMiles: 300, driverId: 'd1' }],
    ];
    const events = planFillEvents(days, 6.5, 500);
    // day1: 300 (< 500, no fill). day2: 600 (>= 500 -> fill, reset). day3: 300 (< 500, no fill).
    expect(events).toHaveLength(1);
    expect(events[0].dateKey).toBe('2026-04-02');
    expect(events[0].milesSinceFill).toBe(600);
    expect(events[0].jurisdiction).toBe('IN');
    expect(events[0].gallons).toBeCloseTo(600 / 6.5, 5);
  });

  it('never fills below the threshold even at the end of the window (no trailing partial fill)', () => {
    const days: Array<[string, { miles: number; jurisdiction: string; jMiles: number; driverId: string | null }]> = [
      ['2026-04-01', { miles: 100, jurisdiction: 'OH', jMiles: 100, driverId: null }],
    ];
    expect(planFillEvents(days, 6.5, 500)).toHaveLength(0);
  });
});

describe('reports mock helpers — computeWebhookSignature', () => {
  it('produces a header the real verifyWebhookSignature() (used by the webhooks module) accepts', () => {
    const secret = 'mock-webhook-hmac-secret-4d21';
    const rawBody = JSON.stringify({ eventType: 'alert', mock: true });
    const header = computeWebhookSignature(secret, 1_800_000_000, rawBody);
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(header, secret, rawBody)).toBe(true);
  });

  it('fails verification against a different secret (not a no-op signature)', () => {
    const rawBody = 'x';
    const header = computeWebhookSignature('secret-a', 1_800_000_000, rawBody);
    expect(verifyWebhookSignature(header, 'secret-b', rawBody)).toBe(false);
  });
});

describe('reports mock helpers — encryptSecretFields', () => {
  it('encrypts secret-looking keys (round-trips through the real decryptValue) and leaves the rest plaintext', () => {
    const config = { url: 'https://example.test/hook', apiKey: 'plain-api-key-value', enabled: true };
    const out = encryptSecretFields(config);
    expect(out.url).toBe('https://example.test/hook');
    expect(out.enabled).toBe(true);
    expect(out.apiKey).not.toBe('plain-api-key-value');
    expect(String(out.apiKey)).toMatch(/^v1:/);
    expect(decryptValue(out.apiKey as string, KEY)).toBe('plain-api-key-value');
  });

  it('leaves non-string secret-looking fields untouched instead of throwing', () => {
    const out = encryptSecretFields({ signingKeyRotationDays: 30 });
    expect(out.signingKeyRotationDays).toBe(30);
  });
});
