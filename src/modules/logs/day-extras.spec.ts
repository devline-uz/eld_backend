/** MR-12 / MR-13 / MR-16 — pure per-day extras of the driver-app log view. */
import { annotateSegments, dayIndicators, tripBlockForDay, type DayTrip, type ExtrasEvent } from './day-extras';
import type { RodsSegment } from './rods';

const DAY_START = new Date('2026-06-01T04:00:00Z');
const DAY_END = new Date('2026-06-02T04:00:00Z');

function ev(over: Partial<ExtrasEvent> & { at: string }): ExtrasEvent {
  return {
    id: 1n,
    eventType: 1,
    eventCode: 1,
    eventSequenceId: 1,
    recordStatus: 1,
    recordOrigin: 1,
    ...over,
    eventDateTime: new Date(over.at),
  };
}

describe('dayIndicators (MR-16)', () => {
  it('is true when a malfunction logged before the day is still open at its start', () => {
    const out = dayIndicators([ev({ at: '2026-05-10T00:00:00Z', eventType: 7, eventCode: 1, malfunctionCode: 'E' })], DAY_START, DAY_END);
    expect(out).toEqual({ malfunctionIndicator: true, diagnosticIndicator: false });
  });

  it('is false when the malfunction was cleared before the day', () => {
    const out = dayIndicators(
      [
        ev({ at: '2026-05-10T00:00:00Z', eventType: 7, eventCode: 1, malfunctionCode: 'E', eventSequenceId: 1 }),
        ev({ at: '2026-05-31T00:00:00Z', eventType: 7, eventCode: 2, malfunctionCode: 'E', eventSequenceId: 2 }),
        ev({ at: '2026-06-01T10:00:00Z', eventSequenceId: 3 }),
      ],
      DAY_START,
      DAY_END,
    );
    expect(out.malfunctionIndicator).toBe(false);
  });

  it('is true for a diagnostic logged and cleared inside the day, and ignores the next day', () => {
    const out = dayIndicators(
      [
        ev({ at: '2026-06-01T10:00:00Z', eventType: 7, eventCode: 3, diagnosticCode: '3', eventSequenceId: 1 }),
        ev({ at: '2026-06-01T11:00:00Z', eventType: 7, eventCode: 4, diagnosticCode: '3', eventSequenceId: 2 }),
        ev({ at: '2026-06-02T10:00:00Z', eventType: 7, eventCode: 1, malfunctionCode: 'P', eventSequenceId: 3 }),
      ],
      DAY_START,
      DAY_END,
    );
    expect(out).toEqual({ malfunctionIndicator: false, diagnosticIndicator: true });
  });

  it('counts a device-reported indicator code on an ordinary record of the day; inactive records never count', () => {
    expect(dayIndicators([ev({ at: '2026-06-01T10:00:00Z', diagnosticCode: '5' })], DAY_START, DAY_END).diagnosticIndicator).toBe(true);
    expect(
      dayIndicators([ev({ at: '2026-06-01T10:00:00Z', eventType: 7, eventCode: 1, recordStatus: 2 })], DAY_START, DAY_END).malfunctionIndicator,
    ).toBe(false);
  });
});

describe('annotateSegments (MR-13)', () => {
  const segment = (startAt: string, endAt: string): RodsSegment => ({
    status: 'ON',
    effective: 'ON',
    special: 'NONE',
    startAt: new Date(startAt),
    endAt: new Date(endAt),
    durationSec: (Date.parse(endAt) - Date.parse(startAt)) / 1000,
  });

  it('takes the fields of the record that opened the segment and flags a carried-over status', () => {
    const events = [
      ev({ id: 5n, at: '2026-05-31T20:00:00Z', eventCode: 4, totalVehicleMiles: 900, totalEngineHours: '100.50', locationName: 'Yard', annotation: 'Loading' }),
      ev({ id: 6n, at: '2026-06-01T12:00:00Z', eventCode: 4, eventSequenceId: 2, totalVehicleMiles: 950, locationName: '2 mi N of Dayton, OH' }),
      ev({ id: 7n, at: '2026-06-01T12:00:00Z', eventType: 3, eventCode: 2, eventSequenceId: 3 }),
    ];
    const [first, second] = annotateSegments(
      [segment('2026-06-01T04:00:00Z', '2026-06-01T12:00:00Z'), segment('2026-06-01T12:00:00Z', '2026-06-01T13:00:00Z')],
      events,
    );
    expect(first).toMatchObject({ eventId: '5', odometerMi: 900, engineHours: 100.5, locationDescription: 'Yard', annotation: 'Loading', carriedOver: true });
    // The duty record wins over the PC/YM indication at the same instant (it carries the location).
    expect(second).toMatchObject({ eventId: '6', odometerMi: 950, locationDescription: '2 mi N of Dayton, OH', carriedOver: false });
  });

  it('yields nulls when no record precedes the segment', () => {
    const [only] = annotateSegments([segment('2026-06-01T04:00:00Z', '2026-06-01T05:00:00Z')], []);
    expect(only).toMatchObject({ eventId: null, odometerMi: null, engineHours: null, locationDescription: null, carriedOver: false });
  });
});

describe('tripBlockForDay (MR-12)', () => {
  const base: DayTrip = {
    id: 't1',
    number: 'T-1',
    status: 'IN_PROGRESS',
    shippingDocument: null,
    shippingDocuments: [],
    trailerNumbers: [],
    trailerNumber: null,
    bobtail: false,
    notes: null,
    plannedStartAt: null,
    plannedEndAt: null,
    startedAt: new Date('2026-06-01T10:00:00Z'),
    completedAt: null,
    createdAt: new Date('2026-05-30T00:00:00Z'),
  };
  const NOW = new Date('2026-06-03T00:00:00Z');

  it('unions documents/trailers of overlapping trips, falls back to the legacy single fields, keeps the last notes', () => {
    const out = tripBlockForDay(
      [
        { ...base, shippingDocument: 'BOL-OLD', trailerNumber: 'TR-1', completedAt: new Date('2026-06-01T12:00:00Z'), status: 'DELIVERED', notes: 'first' },
        { ...base, id: 't2', number: 'T-2', startedAt: new Date('2026-06-01T13:00:00Z'), shippingDocuments: ['BOL-2', 'BOL-OLD'], trailerNumbers: ['TR-2'], notes: 'second' },
      ],
      DAY_START,
      DAY_END,
      NOW,
    );
    expect(out).toEqual({
      shippingDocuments: ['BOL-OLD', 'BOL-2'],
      trailerNumbers: ['TR-1', 'TR-2'],
      notes: 'second',
      bobtail: false,
      tripIds: ['t1', 't2'],
      tripNumbers: ['T-1', 'T-2'],
    });
  });

  it('ignores DRAFT / CANCELLED trips and trips outside the day; empty block otherwise', () => {
    const out = tripBlockForDay(
      [
        { ...base, status: 'DRAFT', shippingDocuments: ['X'] },
        { ...base, status: 'CANCELLED', shippingDocuments: ['Y'] },
        { ...base, startedAt: new Date('2026-06-02T05:00:00Z'), shippingDocuments: ['Z'] },
      ],
      DAY_START,
      DAY_END,
      NOW,
    );
    expect(out).toEqual({ shippingDocuments: [], trailerNumbers: [], notes: null, bobtail: false, tripIds: [], tripNumbers: [] });
  });

  it('reports bobtail when the day’s trip declared no trailer', () => {
    expect(tripBlockForDay([{ ...base, bobtail: true }], DAY_START, DAY_END, NOW).bobtail).toBe(true);
  });
});
