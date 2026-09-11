/** TZ §5.5 — stored §395 records → engine events. */
import { mapEldEventsToNormalized, type EldEventRow } from './hos-event-mapper';

const row = (type: number, code: number, iso: string, extra: Partial<EldEventRow> = {}): EldEventRow => ({
  eventType: type, eventCode: code, eventDateTime: new Date(iso), ...extra,
});

describe('mapEldEventsToNormalized', () => {
  it('maps an empty list', () => expect(mapEldEventsToNormalized([])).toEqual([]));

  it.each([[1, 'OFF'], [2, 'SB'], [3, 'D'], [4, 'ON']] as const)('maps duty code %s to %s', (code, status) => {
    expect(mapEldEventsToNormalized([row(1, code, '2025-01-14T06:00:00Z')])[0].status).toBe(status);
  });

  it('ignores an unknown duty code', () => {
    expect(mapEldEventsToNormalized([row(1, 9, '2025-01-14T06:00:00Z')])).toEqual([]);
  });

  it('ignores unrelated event types', () => {
    expect(mapEldEventsToNormalized([row(6, 1, '2025-01-14T06:00:00Z')])).toEqual([]);
  });

  it('drops records that are not recordStatus 1', () => {
    expect(mapEldEventsToNormalized([row(1, 3, '2025-01-14T06:00:00Z', { recordStatus: 2 })])).toEqual([]);
  });

  it('sorts by time', () => {
    const events = mapEldEventsToNormalized([row(1, 3, '2025-01-14T08:00:00Z'), row(1, 1, '2025-01-14T06:00:00Z')]);
    expect(events.map((e) => e.status)).toEqual(['OFF', 'D']);
  });

  it('breaks ties with eventSequenceId', () => {
    const events = mapEldEventsToNormalized([
      row(1, 3, '2025-01-14T06:00:00Z', { eventSequenceId: 8 }),
      row(1, 1, '2025-01-14T06:00:00Z', { eventSequenceId: 2 }),
    ]);
    expect(events.map((e) => e.status)).toEqual(['OFF', 'D']);
  });

  it('applies a personal conveyance indication to the current status', () => {
    const events = mapEldEventsToNormalized([row(1, 1, '2025-01-14T06:00:00Z'), row(3, 1, '2025-01-14T07:00:00Z')]);
    expect(events[1]).toMatchObject({ status: 'OFF', special: 'PC' });
  });

  it('applies a yard move indication', () => {
    const events = mapEldEventsToNormalized([row(1, 4, '2025-01-14T06:00:00Z'), row(3, 2, '2025-01-14T07:00:00Z')]);
    expect(events[1]).toMatchObject({ status: 'ON', special: 'YM' });
  });

  it('clears an indication with code 0', () => {
    const events = mapEldEventsToNormalized([row(1, 1, '2025-01-14T06:00:00Z'), row(3, 1, '2025-01-14T07:00:00Z'), row(3, 0, '2025-01-14T08:00:00Z')]);
    expect(events[2].special).toBe('NONE');
  });

  it('ignores an indication that arrives before any duty status', () => {
    expect(mapEldEventsToNormalized([row(3, 1, '2025-01-14T06:00:00Z')])).toEqual([]);
  });

  it('carries PC forward across a repeated off-duty record', () => {
    const events = mapEldEventsToNormalized([row(1, 1, '2025-01-14T06:00:00Z'), row(3, 1, '2025-01-14T07:00:00Z'), row(1, 1, '2025-01-14T08:00:00Z')]);
    expect(events[2].special).toBe('PC');
  });

  it('drops PC when the driver goes back to driving', () => {
    const events = mapEldEventsToNormalized([row(1, 1, '2025-01-14T06:00:00Z'), row(3, 1, '2025-01-14T07:00:00Z'), row(1, 3, '2025-01-14T08:00:00Z')]);
    expect(events[2]).toMatchObject({ status: 'D', special: 'NONE' });
  });

  it('drops YM when the driver goes off duty', () => {
    const events = mapEldEventsToNormalized([row(1, 4, '2025-01-14T06:00:00Z'), row(3, 2, '2025-01-14T07:00:00Z'), row(1, 1, '2025-01-14T08:00:00Z')]);
    expect(events[2]).toMatchObject({ status: 'OFF', special: 'NONE' });
  });

  it('keeps YM across a move from on duty to driving', () => {
    const events = mapEldEventsToNormalized([row(1, 4, '2025-01-14T06:00:00Z'), row(3, 2, '2025-01-14T07:00:00Z'), row(1, 3, '2025-01-14T08:00:00Z')]);
    expect(events[2].special).toBe('YM');
  });

  it('treats an unknown indication code as no category', () => {
    const events = mapEldEventsToNormalized([row(1, 1, '2025-01-14T06:00:00Z'), row(3, 7, '2025-01-14T07:00:00Z')]);
    expect(events[1].special).toBe('NONE');
  });

  it('sorts records that carry no sequence id at all', () => {
    const events = mapEldEventsToNormalized([row(1, 3, '2025-01-14T06:00:00Z'), row(1, 1, '2025-01-14T06:00:00Z')]);
    expect(events).toHaveLength(2);
  });

  it('carries the location precision through', () => {
    const events = mapEldEventsToNormalized([row(1, 1, '2025-01-14T06:00:00Z', { locationPrecisionMi: 10 })]);
    expect(events[0].locationPrecisionMi).toBe(10);
  });

  it('normalises a null precision to undefined', () => {
    const events = mapEldEventsToNormalized([row(1, 1, '2025-01-14T06:00:00Z', { locationPrecisionMi: null })]);
    expect(events[0].locationPrecisionMi).toBeUndefined();
  });
});
