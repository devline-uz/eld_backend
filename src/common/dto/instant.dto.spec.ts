import { InstantSchema } from './instant.dto';
import { CreateTripDto, UpdateTripDto } from '../../modules/trips/dto/trips.dto';
import { CreateEditRequestDto, ProposeEventDto } from '../../modules/logs/dto/logs.dto';
import { AssignDriverDto } from '../../modules/vehicles/dto/vehicles.dto';

describe('InstantSchema (B3-04)', () => {
  it.each(['2026-10-16T08:00:00Z', '2026-10-16T08:00:00.123Z', '2026-10-16T03:00:00-05:00', '2026-10-16'])('accepts %s', (value) => {
    const parsed = InstantSchema.parse(value);
    expect(parsed).toBeInstanceOf(Date);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });

  it('parses a date-only value as UTC midnight (what z.coerce.date did)', () => {
    expect(InstantSchema.parse('2026-10-16')).toEqual(new Date('2026-10-16T00:00:00Z'));
  });

  it.each([null, 0, 1_700_000_000_000, '', '0', 'abc', true, '2026-02-30', '2026-10-16T25:00:00Z'])('rejects %p (never 1970)', (value) => {
    expect(InstantSchema.safeParse(value).success).toBe(false);
  });
});

describe('B3-04 — web DTO date fields reject null / 0', () => {
  const tripBase = { number: 'TRP-1', plannedEndAt: '2026-10-20T10:00:00Z' };

  it.each([null, 0])('POST /trips plannedStartAt %p is a 422', (value) => {
    expect(CreateTripDto.safeParse({ ...tripBase, plannedStartAt: value }).success).toBe(false);
  });

  it.each(['plannedStartAt', 'plannedEndAt', 'etaAt', 'completedAt'])('PATCH /trips %s: null is a 422 (cannot be cleared)', (field) => {
    expect(UpdateTripDto.safeParse({ [field]: null }).success).toBe(false);
    expect(UpdateTripDto.safeParse({ [field]: 0 }).success).toBe(false);
  });

  it('stop scheduledAt: null is a 422', () => {
    const stops = [{ sequence: 1, type: 'PICKUP', name: 'A', scheduledAt: null }];
    expect(CreateTripDto.safeParse({ ...tripBase, stops }).success).toBe(false);
  });

  it('still accepts ISO strings', () => {
    const parsed = CreateTripDto.parse({ ...tripBase, plannedStartAt: '2026-10-20T08:00:00.000Z' });
    expect(parsed.plannedStartAt).toEqual(new Date('2026-10-20T08:00:00Z'));
  });

  it.each([null, 0])('POST /logs/:driverId/events eventDateTime %p is a 422', (value) => {
    expect(ProposeEventDto.safeParse({ status: 'ON', eventDateTime: value, annotation: 'Fix log' }).success).toBe(false);
  });

  it.each([null, 0])('edit request proposedStart %p is a 422', (value) => {
    const body = { originalEventId: '1', proposedStatus: 'ON', proposedStart: value, reason: 'Fix log' };
    expect(CreateEditRequestDto.safeParse(body).success).toBe(false);
  });

  it.each([null, 0])('assign-driver effectiveAt %p is a 422', (value) => {
    const body = { driverId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', effectiveAt: value };
    expect(AssignDriverDto.safeParse(body).success).toBe(false);
  });
});
