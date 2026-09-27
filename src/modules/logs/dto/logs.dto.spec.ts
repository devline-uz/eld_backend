/** B-39 / B-72 — request validation for carrier proposals (§395.30, §395.1(e)). */
import { CreateEditRequestDto, ProposeEventDto } from './logs.dto';

const base = {
  originalEventId: '42',
  proposedStatus: 'ON',
  proposedStart: '2026-06-01T12:00:00Z',
  reason: 'Moving trailers in the yard',
};

describe('CreateEditRequestDto (B-39)', () => {
  it('defaults proposedSpecial to NONE and notifyDriver to true', () => {
    const parsed = CreateEditRequestDto.parse(base);
    expect(parsed).toMatchObject({ proposedSpecial: 'NONE', notifyDriver: true });
  });

  it('accepts YM on an ON proposal and PC on an OFF proposal', () => {
    expect(CreateEditRequestDto.safeParse({ ...base, proposedSpecial: 'YM' }).success).toBe(true);
    expect(CreateEditRequestDto.safeParse({ ...base, proposedStatus: 'OFF', proposedSpecial: 'PC' }).success).toBe(true);
  });

  it('refuses PC unless the status is OFF, and YM unless it is ON', () => {
    expect(CreateEditRequestDto.safeParse({ ...base, proposedSpecial: 'PC' }).success).toBe(false);
    expect(CreateEditRequestDto.safeParse({ ...base, proposedStatus: 'SB', proposedSpecial: 'YM' }).success).toBe(false);
    expect(CreateEditRequestDto.safeParse({ ...base, proposedStatus: 'D', proposedSpecial: 'YM' }).success).toBe(false);
  });

  it('accepts a name-only location, refuses half a coordinate pair and an empty location', () => {
    expect(CreateEditRequestDto.safeParse({ ...base, location: { name: 'Acme yard' } }).success).toBe(true);
    expect(CreateEditRequestDto.safeParse({ ...base, location: { lat: 39.1, lon: -84.5 } }).success).toBe(true);
    expect(CreateEditRequestDto.safeParse({ ...base, location: { lat: 39.1, name: 'Acme yard' } }).success).toBe(false);
    expect(CreateEditRequestDto.safeParse({ ...base, location: {} }).success).toBe(false);
  });

  it('refuses an end before the start', () => {
    expect(CreateEditRequestDto.safeParse({ ...base, proposedEnd: '2026-06-01T11:00:00Z' }).success).toBe(false);
  });
});

describe('ProposeEventDto (B-72)', () => {
  const event = {
    status: 'OFF',
    eventDateTime: '2026-06-03T13:00:00Z',
    endDateTime: '2026-06-03T14:30:00Z',
    annotation: 'Driver was at home',
  };

  it('parses the documented request', () => {
    const parsed = ProposeEventDto.parse({ ...event, location: { lat: 39.1, lon: -84.5, name: 'Dayton, OH' }, odometerMi: 1200, engineHours: 4321.4 });
    expect(parsed).toMatchObject({ status: 'OFF', proposedSpecial: 'NONE', notifyDriver: true, engineHours: 4321.4 });
    expect(parsed.eventDateTime).toBeInstanceOf(Date);
  });

  it('requires a 4-60 character annotation', () => {
    expect(ProposeEventDto.safeParse({ ...event, annotation: 'no' }).success).toBe(false);
    expect(ProposeEventDto.safeParse({ ...event, annotation: 'x'.repeat(61) }).success).toBe(false);
  });

  it('refuses an end at or before the start', () => {
    expect(ProposeEventDto.safeParse({ ...event, endDateTime: event.eventDateTime }).success).toBe(false);
  });
});
