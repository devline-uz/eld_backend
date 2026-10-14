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
