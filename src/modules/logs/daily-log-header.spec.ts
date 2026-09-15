/**
 * B-059 — the shared DailyLog header builder. Every writer (GET /logs, hos.recalc, edit
 * acceptance, unidentified assignment) derives the per-day totals through this function.
 */
import {
  affectedHeaderRange,
  buildDailyLogHeaders,
  RODS_HEADER_LOOKBACK_DAYS,
  rodsDayKeys,
} from './daily-log-header';
import type { RodsEvent } from './rods';

const NY = 'America/New_York';
const H = 3600;
const LATER = new Date('2026-07-01T00:00:00Z');

let seq = 0;
function duty(at: string, code: number, extra: Partial<RodsEvent> = {}): RodsEvent {
  seq += 1;
  return {
    id: BigInt(seq),
    eventType: 1,
    eventCode: code,
    eventDateTime: new Date(at),
    recordStatus: 1,
    recordOrigin: 1,
    eventSequenceId: seq,
    supersedesId: null,
    totalVehicleMiles: null,
    ...extra,
  };
}

function build(events: RodsEvent[], fromKey: string, toKey: string, extra: Partial<Parameters<typeof buildDailyLogHeaders>[0]> = {}) {
  return buildDailyLogHeaders({ events, timezone: NY, fromKey, toKey, now: LATER, segments: [], ...extra });
}

describe('rodsDayKeys', () => {
  it('is inclusive on both ends', () => {
    expect(rodsDayKeys('2026-05-30', '2026-06-02')).toEqual(['2026-05-30', '2026-05-31', '2026-06-01', '2026-06-02']);
  });
  it('returns the single day when from = to', () => {
    expect(rodsDayKeys('2026-06-01', '2026-06-01')).toEqual(['2026-06-01']);
  });
  it('is capped', () => {
    expect(rodsDayKeys('2026-01-01', '2026-12-31', 3)).toHaveLength(3);
  });
});

describe('affectedHeaderRange', () => {
  const now = new Date('2026-06-10T16:00:00Z');

  it('covers the changed day and the next one (carry-over past midnight)', () => {
    expect(affectedHeaderRange(NY, new Date('2026-06-01T14:00:00Z'), new Date('2026-06-01T15:00:00Z'), now)).toEqual({
      fromKey: '2026-06-01',
      toKey: '2026-06-02',
    });
  });

  it('uses the home terminal zone, not UTC, for the day boundaries', () => {
    // 2026-06-02T02:00Z is still 2026-06-01 in New York.
    expect(affectedHeaderRange(NY, new Date('2026-06-02T02:00:00Z'), new Date('2026-06-02T02:30:00Z'), now)).toEqual({
      fromKey: '2026-06-01',
      toKey: '2026-06-02',
    });
  });

  it('spans a multi-day change and adds one day after the last', () => {
    expect(affectedHeaderRange(NY, new Date('2026-06-01T14:00:00Z'), new Date('2026-06-04T14:00:00Z'), now)).toEqual({
      fromKey: '2026-06-01',
      toKey: '2026-06-05',
    });
  });

  it('accepts the instants in either order', () => {
    expect(affectedHeaderRange(NY, new Date('2026-06-04T14:00:00Z'), new Date('2026-06-01T14:00:00Z'), now)).toEqual({
      fromKey: '2026-06-01',
      toKey: '2026-06-05',
    });
  });

  it('never goes past today', () => {
    expect(affectedHeaderRange(NY, new Date('2026-06-10T13:00:00Z'), new Date('2026-06-10T14:00:00Z'), now)).toEqual({
      fromKey: '2026-06-10',
      toKey: '2026-06-10',
    });
  });

  it('is null for a span entirely in the future', () => {
    expect(affectedHeaderRange(NY, new Date('2026-06-12T13:00:00Z'), new Date('2026-06-12T14:00:00Z'), now)).toBeNull();
  });
});

describe('buildDailyLogHeaders', () => {
  it('a day with no record is a full off-duty day', () => {
    const [only] = build([], '2026-06-01', '2026-06-01');
    expect(only.header).toMatchObject({ logDate: '2026-06-01', timezone: NY, offDutySec: 24 * H, onDutySec: 0, drivingSec: 0, sleeperSec: 0 });
  });

  it('totals add up to the day length on every day of the range', () => {
    const events = [duty('2026-06-01T12:00:00Z', 3), duty('2026-06-01T20:00:00Z', 2), duty('2026-06-02T06:00:00Z', 4), duty('2026-06-02T09:00:00Z', 1)];
    for (const { header, day } of build(events, '2026-05-31', '2026-06-03')) {
      expect(header.offDutySec + header.sleeperSec + header.drivingSec + header.onDutySec).toBe(day.dayLengthSec);
    }
  });

  it('carries an on-duty status over midnight into the next day', () => {
    // ON from 2026-06-01 22:00 EDT to 2026-06-02 02:00 EDT.
    const events = [duty('2026-06-02T02:00:00Z', 4), duty('2026-06-02T06:00:00Z', 1)];
    const [d1, d2] = build(events, '2026-06-01', '2026-06-02');
    expect(d1.header).toMatchObject({ onDutySec: 2 * H, offDutySec: 22 * H });
    expect(d2.header).toMatchObject({ onDutySec: 2 * H, offDutySec: 22 * H });
  });

  it('counts a sleeper berth carried for several days as SB, not as a leading off-duty gap', () => {
    const events = [duty('2026-05-29T12:00:00Z', 2)];
    const [header] = build(events, '2026-06-01', '2026-06-01').map((b) => b.header);
    expect(header).toMatchObject({ sleeperSec: 24 * H, offDutySec: 0 });
  });

  it('looks back exactly RODS_HEADER_LOOKBACK_DAYS days for the status in force', () => {
    expect(RODS_HEADER_LOOKBACK_DAYS).toBe(9);
    const inside = build([duty('2026-05-23T12:00:00Z', 4)], '2026-06-01', '2026-06-01')[0].header;
    expect(inside.onDutySec).toBe(24 * H);
    const outside = build([duty('2026-05-22T03:00:00Z', 4)], '2026-06-01', '2026-06-01')[0].header;
    expect(outside.onDutySec).toBe(0);
  });

  it('ignores a record retired by an "Inactive — Changed" marker (D-019)', () => {
    const original = duty('2026-06-01T14:00:00Z', 4);
    const marker = duty('2026-06-01T14:00:00Z', 4, { recordStatus: 2, recordOrigin: 3, supersedesId: original.id });
    const neutral = duty('2026-06-01T14:00:00Z', 1, { recordOrigin: 3, supersedesId: original.id });
    const events = [duty('2026-06-01T04:00:00Z', 1), original, duty('2026-06-01T16:00:00Z', 1), marker, neutral];
    const [header] = build(events, '2026-06-01', '2026-06-01').map((b) => b.header);
    expect(header).toMatchObject({ onDutySec: 0, offDutySec: 24 * H, hasEdits: true });
  });

  it('counts driving attributed from an unidentified segment on the driver day', () => {
    const copy = duty('2026-06-01T14:00:00Z', 3, { supersedesId: 900n, totalVehicleMiles: 1000 });
    const restore = duty('2026-06-01T15:00:00Z', 1, { recordOrigin: 3, totalVehicleMiles: 1042 });
    const [header] = build([copy, restore], '2026-06-01', '2026-06-01').map((b) => b.header);
    expect(header).toMatchObject({ drivingSec: H, offDutySec: 23 * H, totalDistanceMi: 42, hasEdits: true });
  });

  it('keeps hasEdits once stored, even if no edit record is in the window any more', () => {
    const previousHasEdits = new Map([['2026-06-01', true]]);
    const [d1, d2] = build([], '2026-06-01', '2026-06-02', { previousHasEdits });
    expect(d1.header.hasEdits).toBe(true);
    expect(d2.header.hasEdits).toBe(false);
  });

  it('raises hasUnassigned only for an overlapping PENDING segment', () => {
    const segments = [
      { status: 'PENDING', startAt: new Date('2026-06-01T14:00:00Z'), endAt: new Date('2026-06-01T15:00:00Z') },
      { status: 'ASSIGNED', startAt: new Date('2026-06-02T14:00:00Z'), endAt: new Date('2026-06-02T15:00:00Z') },
      { status: 'PENDING', startAt: new Date('2026-06-03T03:00:00Z'), endAt: new Date('2026-06-03T04:00:00Z') },
    ];
    const flags = build([], '2026-06-01', '2026-06-03', { segments }).map((b) => b.header.hasUnassigned);
    // 06-03T03:00Z is 06-02 23:00 EDT, so the third segment belongs to 06-02.
    expect(flags).toEqual([true, true, false]);
  });

  it('a segment ending exactly at midnight does not flag the next day', () => {
    const segments = [{ status: 'PENDING', startAt: new Date('2026-06-02T03:00:00Z'), endAt: new Date('2026-06-02T04:00:00Z') }];
    const flags = build([], '2026-06-01', '2026-06-02', { segments }).map((b) => b.header.hasUnassigned);
    expect(flags).toEqual([true, false]);
  });

  it('builds the 23-hour spring-forward day correctly', () => {
    const [header] = build([], '2026-03-08', '2026-03-08').map((b) => b.header);
    expect(header.offDutySec).toBe(23 * H);
  });

  it('builds the 25-hour fall-back day correctly', () => {
    const events = [duty('2026-11-01T04:00:00Z', 2)];
    const [header] = build(events, '2026-11-01', '2026-11-01', { now: new Date('2026-12-01T00:00:00Z') }).map((b) => b.header);
    expect(header.sleeperSec).toBe(25 * H);
  });

  it('a finished day of millisecond-stamped records totals exactly the day length (no rounding drift)', () => {
    // 900 status changes 96.123 s apart, alternating ON / D: rounding each duration alone drifts.
    const events: RodsEvent[] = [];
    const start = Date.parse('2026-06-01T04:00:00Z');
    for (let i = 0; i < 900; i += 1) {
      events.push(duty(new Date(start + 1_000 + Math.round(i * 96_123.4)).toISOString(), i % 2 ? 3 : 4));
    }
    const [built] = build(events, '2026-06-01', '2026-06-01');
    const { header, day } = built;
    expect(header.offDutySec + header.sleeperSec + header.drivingSec + header.onDutySec).toBe(86400);
    expect(day.accountedSec).toBe(86400);
  });

  it('a finished DST day of millisecond-stamped records totals exactly 23 h', () => {
    const events: RodsEvent[] = [];
    const start = Date.parse('2026-03-08T05:00:00Z');
    for (let i = 0; i < 500; i += 1) events.push(duty(new Date(start + 777 + i * 150_333).toISOString(), (i % 4) + 1));
    const [{ header }] = build(events, '2026-03-08', '2026-03-08');
    expect(header.offDutySec + header.sleeperSec + header.drivingSec + header.onDutySec).toBe(23 * H);
  });

  it('accepts unsorted records', () => {
    const events = [duty('2026-06-01T16:00:00Z', 1), duty('2026-06-01T14:00:00Z', 4)];
    const [header] = build(events, '2026-06-01', '2026-06-01').map((b) => b.header);
    expect(header.onDutySec).toBe(2 * H);
  });

  it('stops at now for the day still running', () => {
    const now = new Date('2026-06-01T16:00:00Z'); // 12:00 EDT
    const [only] = buildDailyLogHeaders({ events: [], timezone: NY, fromKey: '2026-06-01', toKey: '2026-06-01', now, segments: [] });
    expect(only.header.offDutySec).toBe(12 * H);
  });

  it('respects maxDays', () => {
    expect(build([], '2026-01-01', '2026-06-01', { maxDays: 5 })).toHaveLength(5);
  });
});
