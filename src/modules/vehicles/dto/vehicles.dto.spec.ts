import { CreateVehicleDto, ImportVehiclesDto, UpdateVehicleDto, VEHICLE_IMPORT_MAX_ROWS, VIN_MESSAGE } from './vehicles.dto';

const base = { unitNumber: '7301' };

describe('web-panel VIN validation (ISO 3779: 17 chars, no I/O/Q)', () => {
  it('accepts a valid VIN and upper-cases / trims it first', () => {
    const parsed = CreateVehicleDto.parse({ ...base, vin: '  1fujhhdr5nlnn4410 ' });
    expect(parsed.vin).toBe('1FUJHHDR5NLNN4410');
  });

  it.each([
    ['contains I', '1FUJHHDR5NLNN44I0'],
    ['contains O', '1FUJHHDR5NLNN44O0'],
    ['contains Q', '1FUJHHDR5NLNN44Q0'],
    ['lower-case q (upper-cased before the check)', '1fujhhdr5nlnn44q0'],
    ['16 characters', '1FUJHHDR5NLNN441'],
    ['18 characters', '1FUJHHDR5NLNN44100'],
    ['punctuation', '1FUJHHDR5-LNN4410'],
    ['empty', ''],
  ])('rejects a VIN that %s', (_label, vin) => {
    const result = CreateVehicleDto.safeParse({ ...base, vin });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(VIN_MESSAGE);
  });

  it('applies to every import row and points at the bad row', () => {
    const result = ImportVehiclesDto.safeParse({
      vehicles: [
        { unitNumber: '1', vin: '1FUJHHDR5NLNN4410' },
        { unitNumber: '2', vin: '1FUJHHDR5NLNN44O0' },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['vehicles', 1, 'vin']);
  });

  it('upper-cases import rows too', () => {
    const parsed = ImportVehiclesDto.parse({ vehicles: [{ unitNumber: '1', vin: '1fujhhdr5nlnn4410' }] });
    expect(parsed.vehicles[0]?.vin).toBe('1FUJHHDR5NLNN4410');
  });

  it('PATCH leaves vin optional but validates it when sent', () => {
    expect(UpdateVehicleDto.safeParse({ make: 'Volvo' }).success).toBe(true);
    expect(UpdateVehicleDto.safeParse({ vin: '1FUJHHDR5NLNN44I0' }).success).toBe(false);
  });
});

describe('ImportVehiclesDto row cap (web tz.md — "2,000 rows maximum")', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ unitNumber: String(i + 1), vin: '1FUJHHDR5NLNN4410' }));

  it('caps at 2,000 rows', () => {
    expect(VEHICLE_IMPORT_MAX_ROWS).toBe(2000);
  });

  it('accepts exactly 2,000 rows', () => {
    expect(ImportVehiclesDto.safeParse({ vehicles: rows(2000) }).success).toBe(true);
  });

  it('rejects 2,001 rows on the `vehicles` array', () => {
    const result = ImportVehiclesDto.safeParse({ vehicles: rows(2001) });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['vehicles']);
  });
});
