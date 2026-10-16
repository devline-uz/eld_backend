import {
  AssignDriverDto,
  CalibrateOdometerDto,
  CreateTrailerDto,
  CreateVehicleDto,
  ImportVehiclesDto,
  TrailerListQueryDto,
  UpdateVehicleDto,
  VEHICLE_IMPORT_MAX_ROWS,
  VehicleListQueryDto,
  VIN_MESSAGE,
} from './vehicles.dto';

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

describe('BE-007 / BE-008 / BE-015 / BE-017 — bounds, trimming and plate state', () => {
  const VIN = '1FUJHHDR5NLNN4410';

  it('caps page on the vehicle and trailer lists (no 500 on a huge OFFSET)', () => {
    expect(VehicleListQueryDto.safeParse({ page: '99999999999' }).success).toBe(false);
    expect(TrailerListQueryDto.safeParse({ page: '99999999999' }).success).toBe(false);
    expect(VehicleListQueryDto.parse({ page: '3' }).page).toBe(3);
  });

  it('rejects an odometer beyond the INT4-safe cap on create and calibrate', () => {
    expect(CreateVehicleDto.safeParse({ ...base, vin: VIN, odometerMi: 2_147_483_648 }).success).toBe(false);
    expect(CalibrateOdometerDto.safeParse({ odometerMi: 2_147_483_648 }).success).toBe(false);
    expect(CreateVehicleDto.parse({ ...base, vin: VIN, odometerMi: 650_000 }).odometerMi).toBe(650_000);
  });

  it('trims the unit / trailer number and rejects whitespace-only', () => {
    expect(CreateVehicleDto.parse({ unitNumber: '  101 ', vin: VIN }).unitNumber).toBe('101');
    expect(CreateVehicleDto.safeParse({ unitNumber: '   ', vin: VIN }).success).toBe(false);
    expect(CreateTrailerDto.safeParse({ number: '   ' }).success).toBe(false);
  });

  it('plate state: upper-cases a valid US/CA code, keeps empty / null, rejects junk', () => {
    expect(CreateVehicleDto.parse({ ...base, vin: VIN, plateState: ' oh ' }).plateState).toBe('OH');
    expect(CreateVehicleDto.parse({ ...base, vin: VIN, plateState: 'ON' }).plateState).toBe('ON');
    expect(UpdateVehicleDto.parse({ plateState: '' }).plateState).toBe('');
    expect(UpdateVehicleDto.parse({ plateState: null }).plateState).toBeNull();
    expect(CreateVehicleDto.safeParse({ ...base, vin: VIN, plateState: 'ZZZZZ' }).success).toBe(false);
    expect(CreateVehicleDto.safeParse({ ...base, vin: VIN, plateState: 'ZZ' }).success).toBe(false);
  });
});

describe('AssignDriverDto — B3-12 effectiveAt is not supported', () => {
  const driverId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  it('assigns immediately: a body without effectiveAt is accepted', () => {
    expect(AssignDriverDto.parse({ driverId })).toEqual({ driverId, notify: true });
  });

  it('rejects any effectiveAt (a scheduled assignment used to be silently applied now)', () => {
    const result = AssignDriverDto.safeParse({ driverId, effectiveAt: '2026-11-01T08:00:00.000Z' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ['effectiveAt'] });
  });
});

describe('list search `q` — L3-06 trimmed server-side', () => {
  it('trims q on vehicles and trailers (" 101 " finds unit 101; whitespace-only = no filter)', () => {
    expect(VehicleListQueryDto.parse({ q: ' 101 ' }).q).toBe('101');
    expect(TrailerListQueryDto.parse({ q: '\tTR-9 ' }).q).toBe('TR-9');
    expect(VehicleListQueryDto.parse({ q: '   ' }).q).toBe('');
  });
});
