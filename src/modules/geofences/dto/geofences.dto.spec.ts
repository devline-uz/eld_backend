import { CreateGeofenceDto, UpdateGeofenceDto } from './geofences.dto';

describe('geofence polygon points (CODE-061)', () => {
  const square = [
    { lat: 39.9, lon: -83.0 },
    { lat: 39.9, lon: -82.9 },
    { lat: 40.0, lon: -82.9 },
  ];

  it('accepts a polygon of real coordinates', () => {
    expect(CreateGeofenceDto.safeParse({ name: 'Yard', type: 'POLYGON', polygon: square }).success).toBe(true);
  });

  it.each([
    ['latitude above 90', { lat: 91, lon: -83 }],
    ['longitude below -180', { lat: 39.9, lon: -200 }],
    ['a non-finite value', { lat: Number.NaN, lon: -83 }],
  ])('refuses a vertex with %s', (_label, bad) => {
    const polygon = [bad, ...square.slice(1)];
    expect(CreateGeofenceDto.safeParse({ name: 'Yard', type: 'POLYGON', polygon }).success).toBe(false);
    expect(UpdateGeofenceDto.safeParse({ polygon }).success).toBe(false);
  });

  it('refuses a ring of fewer than 3 different points', () => {
    const polygon = [square[0], square[0], square[1]];
    expect(CreateGeofenceDto.safeParse({ name: 'Yard', type: 'POLYGON', polygon }).success).toBe(false);
  });
});

describe('geofence "Applies to" scope (overlay 11.1)', () => {
  const base = { name: 'Yard', type: 'CIRCLE', centerLat: 40, centerLon: -83, radiusMi: 0.5 };
  const GROUP = '11111111-1111-4111-8111-111111111111';
  const UNIT_A = '22222222-2222-4222-8222-222222222222';
  const UNIT_B = '33333333-3333-4333-8333-333333333333';

  it('accepts specific units and de-duplicates them', () => {
    const parsed = CreateGeofenceDto.parse({ ...base, vehicleGroupId: null, vehicleIds: [UNIT_A, UNIT_B, UNIT_A] });
    expect(parsed.vehicleIds).toEqual([UNIT_A, UNIT_B]);
    expect(UpdateGeofenceDto.parse({ vehicleIds: [UNIT_B, UNIT_B] }).vehicleIds).toEqual([UNIT_B]);
  });

  it('refuses a group and units together (mutually exclusive)', () => {
    const create = CreateGeofenceDto.safeParse({ ...base, vehicleGroupId: GROUP, vehicleIds: [UNIT_A] });
    expect(create.success).toBe(false);
    expect(create.error?.issues[0].path).toEqual(['vehicleIds']);
    expect(UpdateGeofenceDto.safeParse({ vehicleGroupId: GROUP, vehicleIds: [UNIT_A] }).success).toBe(false);
  });

  it('allows a group with an empty unit list, and units with a null group', () => {
    expect(CreateGeofenceDto.safeParse({ ...base, vehicleGroupId: GROUP, vehicleIds: [] }).success).toBe(true);
    expect(UpdateGeofenceDto.safeParse({ vehicleGroupId: GROUP, vehicleIds: [] }).success).toBe(true);
    expect(UpdateGeofenceDto.safeParse({ vehicleGroupId: null, vehicleIds: [UNIT_A] }).success).toBe(true);
  });

  it('refuses non-uuid unit ids and more than 500 units', () => {
    expect(CreateGeofenceDto.safeParse({ ...base, vehicleIds: ['veh_1'] }).success).toBe(false);
    const many = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(UpdateGeofenceDto.safeParse({ vehicleIds: many }).success).toBe(false);
  });
});
