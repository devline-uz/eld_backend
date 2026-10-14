import { canonicalUnitNumber, normalizePlate, normalizeVehicleUniques } from './vehicle-uniques';

describe('vehicle uniques (CODE-044)', () => {
  it.each([
    ['ABC 123', 'ABC123'],
    ['abc-123', 'ABC123'],
    ['  a b - c 1 2 3 ', 'ABC123'],
    [' - ', null],
    ['', null],
  ])('normalizePlate(%j) -> %j', (input, expected) => {
    expect(normalizePlate(input)).toBe(expected);
  });

  it('keeps undefined (PATCH leaves the plate alone) and null', () => {
    expect(normalizePlate(undefined)).toBeUndefined();
    expect(normalizePlate(null)).toBeNull();
  });

  it('normalizeVehicleUniques compacts the plate but not the state or serial', () => {
    expect(normalizeVehicleUniques({ licensePlate: 'pqr-4821', plateState: ' oh ', deviceId: ' pt30_a1 ' })).toEqual({
      licensePlate: 'PQR4821',
      plateState: 'OH',
      eldSerial: 'PT30_A1',
    });
  });

  it.each([
    ['#101', '101'],
    [' 101 ', '101'],
    ['t1', 'T1'],
    ['##7a', '7A'],
  ])('canonicalUnitNumber(%j) -> %j', (input, expected) => {
    expect(canonicalUnitNumber(input)).toBe(expected);
  });
});
