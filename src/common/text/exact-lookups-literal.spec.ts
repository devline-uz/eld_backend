/**
 * High-risk exact lookups (uniqueness checks, pairing, linking, login) must be LITERAL: a value
 * containing `%` / `_` / `\` must never resolve another row. The fake tables evaluate Prisma's
 * filters the way Postgres does (unescaped ILIKE / LIKE, see `test/helpers/fake-like-filters.ts`),
 * so these tests fail if a repository goes back to a raw `{ equals, mode: 'insensitive' }`.
 */
import { fakeLikeTable, matchesStringFilter, matchesWhere } from '../../../test/helpers/fake-like-filters';
import { fakeUserEmailTable } from '../../../test/helpers/fake-user-email-table';
import { VehiclesRepository } from '../../modules/vehicles/vehicles.repository';
import { MobileRepository } from '../../modules/mobile/mobile.repository';
import { MobileFleetOpsRepository } from '../../modules/mobile/mobile-fleet-ops.repository';
import { DriversRepository } from '../../modules/drivers/drivers.repository';
import { DriverAuthRepository } from '../../modules/auth/repositories/driver-auth.repository';
import { UsersRepository } from '../../modules/users/users.repository';

describe('VehiclesRepository exact lookups are literal', () => {
  const vehicles = [
    { id: 'v101', unitNumber: '101', vin: '1HGCM82633A004352', licensePlate: 'ABC123', plateState: 'TX', deletedAt: null },
    { id: 'v_pct', unitNumber: '1%1', vin: 'VIN%LITERAL', licensePlate: 'A_C123', plateState: 'T_', deletedAt: null },
  ];
  const devices = [{ id: 'd1', serial: 'PT30ABC', vehicleId: null }];
  const build = () => {
    const vehicle = fakeLikeTable(vehicles);
    const device = fakeLikeTable(devices);
    return new VehiclesRepository({ vehicle, device } as never);
  };

  it('findByUnitNumber: `1_1` / `%` do not match unit 101, the literal `1%1` still matches', async () => {
    const repo = build();
    expect(await repo.findByUnitNumber('1_1')).toBeNull();
    expect(await repo.findByUnitNumber('%')).toBeNull();
    expect((await repo.findByUnitNumber(' #1%1 '))?.id).toBe('v_pct');
    expect((await repo.findByUnitNumber('#101'))?.id).toBe('v101');
  });

  it('findByVin: a wildcard VIN does not match another unit', async () => {
    const repo = build();
    expect(await repo.findByVin('1HGCM82633A00435_')).toBeNull();
    expect(await repo.findByVin('%')).toBeNull();
    expect((await repo.findByVin(' 1hgcm82633a004352 '))?.id).toBe('v101');
    expect((await repo.findByVin('vin%literal'))?.id).toBe('v_pct');
  });

  it('findDeviceForPairing: `PT30%` / `pt30ab_` do not claim device PT30ABC', async () => {
    const repo = build();
    expect(await repo.findDeviceForPairing('PT30%')).toBeNull();
    expect(await repo.findDeviceForPairing('pt30ab_')).toBeNull();
    expect((await repo.findDeviceForPairing('pt30abc'))?.id).toBe('d1');
  });

  it('findLiveByPlate: `A_C123`/`T_` is only the literal plate, not ABC123/TX', async () => {
    const repo = build();
    expect((await repo.findLiveByPlate('A_C123', 'T_'))?.id).toBe('v_pct');
    expect(await repo.findLiveByPlate('ABC12_', 'TX')).toBeNull();
    expect(await repo.findLiveByPlate('%', '%')).toBeNull();
    expect((await repo.findLiveByPlate('abc123', 'tx'))?.id).toBe('v101');
  });
});

describe('Mobile trailer linking is literal', () => {
  const trailers = [{ id: 't1', number: 'TR-01', vin: 'TVIN1', status: 'ACTIVE', deletedAt: null }];

  it('findActiveTrailerByNumber: `TR_01` / `%` do not link trailer TR-01', async () => {
    const repo = new MobileRepository({ trailer: fakeLikeTable(trailers) } as never);
    expect(await repo.findActiveTrailerByNumber('TR_01')).toBeNull();
    expect(await repo.findActiveTrailerByNumber('%')).toBeNull();
    expect((await repo.findActiveTrailerByNumber('tr-01'))?.id).toBe('t1');
  });

  it('findTrailersByNumbers (LOWER IN, no LIKE) matches case-insensitively and never by pattern', async () => {
    const repo = new MobileFleetOpsRepository({ trailer: fakeLikeTable(trailers) } as never);
    expect((await repo.findTrailersByNumbers(['tr-01'])).map((t) => t.id)).toEqual(['t1']);
    expect(await repo.findTrailersByNumbers(['TR_01', '%'])).toEqual([]);
  });

  it('listActiveTrailers search treats `%` / `_` literally', async () => {
    const repo = new MobileFleetOpsRepository({ trailer: fakeLikeTable(trailers) } as never);
    expect(await repo.listActiveTrailers('%', 10)).toEqual([]);
    expect(await repo.listActiveTrailers('r_0', 10)).toEqual([]);
    expect((await repo.listActiveTrailers('r-0', 10)).map((t) => t.id)).toEqual(['t1']);
  });
});

describe('Drivers lookups are literal', () => {
  it('listRoster `terminal` filter: `Col_mbus%` does not match "Columbus, OH"', async () => {
    const driver = { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) };
    const repo = new DriversRepository({ driver } as never);
    await repo.listRoster({ terminal: 'Col_mbus%' }, 1, 25, {});
    await repo.listRoster({ terminal: 'columbus, oh' }, 1, 25, {});
    const filterOf = (call: number) => {
      const where = JSON.stringify((driver.findMany.mock.calls[call] as [{ where: unknown }])[0].where);
      const m = /"homeTerminalName":(\{[^}]*\})/.exec(where);
      return JSON.parse(m![1]) as unknown;
    };
    expect(matchesStringFilter('Columbus, OH', filterOf(0))).toBe(false);
    expect(matchesStringFilter('Columbus, OH', filterOf(1))).toBe(true);
  });

  it('findByEmail / driver login by email: `%` and `j_hn@x.com` do not resolve john@x.com', async () => {
    const rows = [{ id: 'd1', username: 'john', email: 'john@x.com', deletedAt: null }];
    const drivers = new DriversRepository({ driver: fakeLikeTable(rows) } as never);
    expect(await drivers.findByEmail('%')).toBeNull();
    expect(await drivers.findByEmail('j_hn@x.com')).toBeNull();
    expect((await drivers.findByEmail(' JOHN@x.com '))?.id).toBe('d1');

    const auth = new DriverAuthRepository({ driver: fakeLikeTable(rows) } as never);
    expect(await auth.findByUsernameOrEmail('%')).toBeNull();
    expect(await auth.findByUsernameOrEmail('j_hn@x.com')).toBeNull();
    expect((await auth.findByUsernameOrEmail('john'))?.id).toBe('d1');
  });

  it('BE-20 — admin username lookups are case-insensitive but literal; an exact username wins', async () => {
    const rows = [
      { id: 'd1', username: 'JDoe', email: 'other@x.com', deletedAt: null },
      { id: 'd2', username: 'jdoe', email: null, deletedAt: null },
      { id: 'd3', username: 'mary', email: 'jdoe2@x.com', deletedAt: null },
      { id: 'd4', username: 'jdoe2@x.com', email: null, deletedAt: null },
    ];
    const drivers = new DriversRepository({ driver: fakeLikeTable(rows) } as never);
    expect((await drivers.findByUsername('JDOE'))?.id).toBe('d1');
    expect((await drivers.findByUsername('jdoe'))?.id).toBe('d2');
    expect((await drivers.findByUsername('MARY'))?.id).toBe('d3');
    expect(await drivers.findByUsername('m_ry')).toBeNull();
  });
});

describe('Users email lookups are literal', () => {
  it('findByEmail / findByEmailInsensitive: `%` and `j_hn@x.com` do not resolve john@x.com', async () => {
    const table = fakeUserEmailTable([{ id: 'u1', email: 'john@x.com' }]);
    const repo = new UsersRepository(table.prisma as never);
    expect(await repo.findByEmail('%')).toBeNull();
    expect(await repo.findByEmailInsensitive('j_hn@x.com')).toBeNull();
    expect((await repo.findByEmail('John@X.com'))?.id).toBe('u1');
  });
});

describe('fake evaluator sanity', () => {
  it('reproduces the Prisma bug for an unescaped filter', () => {
    expect(matchesWhere({ number: 'TR-01' }, { number: { equals: 'TR_01', mode: 'insensitive' } })).toBe(true);
  });
});
