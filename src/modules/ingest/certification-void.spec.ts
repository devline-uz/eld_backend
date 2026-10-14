import { headersToVoid, voidingInstantsByDriver } from './certification-void';

describe('B-123 — which fresh records void a certified RODS day', () => {
  const at = new Date('2026-06-01T14:00:00Z');

  it('keeps only the driver-owned, active duty / intermediate / PC-YM records', () => {
    const map = voidingInstantsByDriver([
      { driverId: 'd1', eventType: 1, recordStatus: 1, at, unidentified: false },
      { driverId: 'd1', eventType: 2, at, unidentified: false },
      { driverId: 'd1', eventType: 3, recordStatus: 1, at, unidentified: false },
      { driverId: 'd1', eventType: 4, recordStatus: 1, at, unidentified: false },
      { driverId: 'd1', eventType: 5, recordStatus: 1, at, unidentified: false },
      { driverId: 'd1', eventType: 6, recordStatus: 1, at, unidentified: false },
      { driverId: 'd1', eventType: 7, recordStatus: 1, at, unidentified: false },
      { driverId: 'd1', eventType: 1, recordStatus: 3, at, unidentified: false },
      { driverId: 'd2', eventType: 1, recordStatus: 1, at, unidentified: true },
      { driverId: null, eventType: 1, recordStatus: 1, at, unidentified: false },
    ]);
    expect([...map.keys()]).toEqual(['d1']);
    expect(map.get('d1')).toHaveLength(3);
  });

  it('matches the RODS day in the header zone, DST-correct', () => {
    const ny = { id: 'h1', driverId: 'd1', logDate: new Date('2026-06-01T00:00:00Z'), timezone: 'America/New_York', certifiedAt: null };
    // 04:00Z Jun 1 = 00:00 EDT (inside); 03:59Z = Mar 31 23:59 EDT (outside); 03:59Z Jun 2 = 23:59 Jun 1 (inside).
    expect(headersToVoid([ny], [new Date('2026-06-01T04:00:00Z')])).toEqual([ny]);
    expect(headersToVoid([ny], [new Date('2026-06-01T03:59:00Z')])).toEqual([]);
    expect(headersToVoid([ny], [new Date('2026-06-02T03:59:00Z')])).toEqual([ny]);
    expect(headersToVoid([ny], [new Date('2026-06-02T04:00:00Z')])).toEqual([]);
  });

  it('only records dated after certifiedAt void it (late-arriving older records do not)', () => {
    const signed = { id: 'h2', driverId: 'd1', logDate: new Date('2026-06-01T00:00:00Z'), timezone: 'America/New_York', certifiedAt: new Date('2026-06-01T16:00:00Z') };
    expect(headersToVoid([signed], [new Date('2026-06-01T15:59:59Z')])).toEqual([]);
    expect(headersToVoid([signed], [new Date('2026-06-01T16:00:00Z')])).toEqual([]);
    expect(headersToVoid([signed], [new Date('2026-06-01T16:00:01Z')])).toEqual([signed]);
  });
});
