/** Web gaps B-1 / B-2 — the fleet read of the HOS engine. */
import { AppException } from '../../common/errors/app.exception';
import { HosRecalcService } from '../hos-recalc/hos-recalc.service';
import type { HosRecalcRepository } from '../hos-recalc/hos-recalc.repository';
import { DriverRosterQueryDto } from './dto/drivers.dto';
import { DriverRosterService, toWebDutyStatus } from './driver-roster.service';
import type { DriversRepository } from './drivers.repository';

const H = 3600;

function makeDriver(overrides: Record<string, unknown> = {}) {
  return {
    id: 'drv_1',
    username: 'jsmith',
    passwordHash: 'secret-hash',
    firstName: 'John',
    lastName: 'Smith',
    email: 'john@example.com',
    phone: null,
    cdlNumber: 'D1',
    cdlState: 'OH',
    status: 'ACTIVE',
    homeTerminalName: 'Columbus, OH',
    homeTerminalTimezone: 'America/New_York',
    hosRuleset: 'US_70_8_PROPERTY',
    fleetManagerId: null,
    assignedVehicleId: 'veh_1',
    allowPersonalConveyance: true,
    allowYardMove: true,
    adverseDrivingEnabled: false,
    shortHaulException: false,
    splitSleeperEnabled: false,
    eldExempt: false,
    eldExemptReason: null,
    appVersion: 'v2.24',
    assignedVehicle: { id: 'veh_1', unitNumber: '101' },
    ...overrides,
  };
}

type Row = { driverId: string; eventType: number; eventCode: number; eventDateTime: Date; recordStatus: number; eventSequenceId: number };
const duty = (driverId: string, iso: string, code: number, seq: number): Row => ({
  driverId,
  eventType: 1,
  eventCode: code,
  eventDateTime: new Date(iso),
  recordStatus: 1,
  eventSequenceId: seq,
});

/** A HosRecalcService over an in-memory repo — the REAL engine runs, only I/O is faked. */
function makeHos(events: Row[], dailyLogs: Array<{ driverId: string; logDate: Date; onDutySec: number; drivingSec: number }> = []) {
  const repo = {
    findEventsForDrivers: jest.fn(async (windows: Array<{ driverId: string; from: Date }>, to: Date) =>
      events.filter((e) => windows.some((w) => w.driverId === e.driverId && e.eventDateTime >= w.from) && e.eventDateTime <= to),
    ),
    findDailyLogsForDrivers: jest.fn(async (ids: string[], from: Date, to: Date) =>
      dailyLogs.filter((l) => ids.includes(l.driverId) && l.logDate >= from && l.logDate <= to),
    ),
  };
  return { repo, service: new HosRecalcService(repo as unknown as HosRecalcRepository) };
}

function makeDriversRepo(items: Array<ReturnType<typeof makeDriver>>, open: Record<string, number> = {}) {
  return {
    listRoster: jest.fn().mockResolvedValue({ items, total: items.length }),
    countOpenViolations: jest.fn(async () => new Map(Object.entries(open))),
    findById: jest.fn(async ({ id }: { id: string }) => items.find((d) => d.id === id) ?? null),
  };
}

const query = (overrides: Record<string, unknown> = {}) => DriverRosterQueryDto.parse({ ...overrides });

describe('toWebDutyStatus', () => {
  it.each([
    ['D', 'DRIVING'],
    ['ON', 'ON_DUTY'],
    ['SB', 'SLEEPER'],
    ['OFF', 'OFF_DUTY'],
  ] as const)('%s -> %s', (engine, web) => {
    expect(toWebDutyStatus(engine)).toBe(web);
  });
});

describe('DriverRosterQueryDto', () => {
  it('defaults page/limit and leaves filters undefined', () => {
    expect(query()).toEqual({ page: 1, limit: 25 });
  });

  it('coerces the boolean filters from query strings', () => {
    expect(query({ hasOpenViolation: 'true', exempt: 'false', terminal: 'Columbus, OH' })).toMatchObject({
      hasOpenViolation: true,
      exempt: false,
      terminal: 'Columbus, OH',
    });
  });

  it('rejects a non-boolean filter value', () => {
    expect(() => query({ exempt: 'yes' })).toThrow();
  });
});

describe('DriverRosterService.roster', () => {
  // 2026-09-12 America/New_York: 10 h off, ON at 06:00 local, driving 07:00-10:00 local, now 11:00 local.
  const NOW = new Date('2026-09-12T15:00:00Z');
  const events = [
    duty('drv_1', '2026-09-11T20:00:00Z', 1, 1),
    duty('drv_1', '2026-09-12T10:00:00Z', 4, 2),
    duty('drv_1', '2026-09-12T11:00:00Z', 3, 3),
  ];

  it('returns the documented B-1 shape with engine clocks, unit and open violations', async () => {
    const drivers = makeDriversRepo([makeDriver(), makeDriver({ id: 'drv_2', username: 'awebb', assignedVehicle: null, assignedVehicleId: null })], { drv_1: 2 });
    const { service: hos } = makeHos(events);
    const service = new DriverRosterService(drivers as unknown as DriversRepository, hos);

    const page = await service.roster(query({ page: '1', limit: '25', q: 'smith' }), NOW);

    expect(Object.keys(page).sort()).toEqual(['items', 'limit', 'page', 'total', 'totalPages']);
    expect(page).toMatchObject({ page: 1, limit: 25, total: 2, totalPages: 1 });
    const [first, second] = page.items;
    expect(Object.keys(first).sort()).toEqual(['driver', 'dutyStatus', 'emailVerified', 'hos', 'openViolations', 'unit']);
    expect(first.driver).not.toHaveProperty('passwordHash');
    expect(first.driver).toEqual({
      id: 'drv_1',
      username: 'jsmith',
      firstName: 'John',
      lastName: 'Smith',
      homeTerminalName: 'Columbus, OH',
      appVersion: 'v2.24',
      email: 'john@example.com',
      eldExempt: false,
      allowPersonalConveyance: true,
      allowYardMove: true,
      shortHaulException: false,
      splitSleeperEnabled: false,
    });
    expect(first.dutyStatus).toBe('DRIVING');
    expect(first.unit).toEqual({ id: 'veh_1', unitNumber: '101' });
    expect(first.openViolations).toBe(2);
    expect(first.emailVerified).toBeNull();
    // 4 h drive used, shift opened 5 h ago.
    expect(first.hos).toEqual({ driveRemainingSec: 11 * H - 4 * H, shiftRemainingSec: 14 * H - 5 * H, cycleRemainingSec: 70 * H - 5 * H });

    expect(second.unit).toBeNull();
    expect(second.openViolations).toBe(0);
    expect(second.dutyStatus).toBe('OFF_DUTY');
    expect(second.hos).toEqual({ driveRemainingSec: 11 * H, shiftRemainingSec: 14 * H, cycleRemainingSec: 70 * H });
  });

  it('passes every filter and the default lastName sort to the repository', async () => {
    const drivers = makeDriversRepo([]);
    const { service: hos } = makeHos([]);
    const service = new DriverRosterService(drivers as unknown as DriversRepository, hos);
    await service.roster(query({ status: 'ACTIVE', q: 'x', terminal: 'T', hasOpenViolation: 'true', exempt: 'false', page: '3', limit: '10' }), NOW);
    expect(drivers.listRoster).toHaveBeenCalledWith(
      { status: 'ACTIVE', q: 'x', terminal: 'T', hasOpenViolation: true, exempt: false },
      3,
      10,
      { lastName: 'asc' },
    );
  });

  it('honours an allowed sort and computes totalPages', async () => {
    const drivers = makeDriversRepo([]);
    drivers.listRoster.mockResolvedValue({ items: [], total: 58 });
    const { service: hos } = makeHos([]);
    const service = new DriverRosterService(drivers as unknown as DriversRepository, hos);
    const page = await service.roster(query({ sort: 'homeTerminalName:desc' }), NOW);
    expect((drivers.listRoster.mock.calls[0] as unknown[])[3]).toEqual({ homeTerminalName: 'desc' });
    expect(page).toMatchObject({ total: 58, totalPages: 3, items: [] });
  });

  it('an empty page issues no engine reads', async () => {
    const drivers = makeDriversRepo([]);
    const { repo, service: hos } = makeHos([]);
    const service = new DriverRosterService(drivers as unknown as DriversRepository, hos);
    const page = await service.roster(query(), NOW);
    expect(page.totalPages).toBe(1);
    expect(repo.findEventsForDrivers).not.toHaveBeenCalled();
  });

  it('falls back to full ruleset limits if the engine returned no state for a row', async () => {
    const drivers = makeDriversRepo([makeDriver({ hosRuleset: 'US_60_7_PASSENGER' })]);
    const hos = { computeCurrentStates: jest.fn().mockResolvedValue(new Map()) };
    const service = new DriverRosterService(drivers as unknown as DriversRepository, hos as unknown as HosRecalcService);
    const page = await service.roster(query(), NOW);
    expect(page.items[0].dutyStatus).toBe('OFF_DUTY');
    expect(page.items[0].hos).toEqual({ driveRemainingSec: 10 * H, shiftRemainingSec: 15 * H, cycleRemainingSec: 60 * H });
  });
});

describe('DriverRosterService.clocks', () => {
  it('throws DRIVER_NOT_FOUND for an unknown driver', async () => {
    const { service: hos } = makeHos([]);
    const service = new DriverRosterService(makeDriversRepo([]) as unknown as DriversRepository, hos);
    await expect(service.clocks('nope')).rejects.toBeInstanceOf(AppException);
  });

  it('returns the B-2 shape with limits for a driver with no events', async () => {
    const NOW = new Date('2026-09-12T15:00:00Z');
    const { service: hos } = makeHos([]);
    const service = new DriverRosterService(makeDriversRepo([makeDriver()]) as unknown as DriversRepository, hos);
    const clocks = await service.clocks('drv_1', NOW);
    expect(clocks).toEqual({
      driveRemainingSec: 11 * H,
      shiftRemainingSec: 14 * H,
      cycleRemainingSec: 70 * H,
      breakInSec: 8 * H,
      onDutySince: null,
      cycleLimitSec: 70 * H,
      shiftLimitSec: 14 * H,
      driveLimitSec: 11 * H,
      breakLimitSec: 8 * H,
      dutyStatus: 'OFF_DUTY',
      statusSince: NOW.toISOString(),
      computedAt: NOW.toISOString(),
    });
  });

  it('a shift and a break that straddle the home-terminal midnight are counted across it', async () => {
    // America/Chicago midnight = 05:00Z. OFF 10 h, ON 22:00 local, D 22:30-03:30 local (5 h), now 03:30.
    const NOW = new Date('2026-09-12T08:30:00Z');
    const events = [
      duty('drv_1', '2026-09-11T17:00:00Z', 1, 1),
      duty('drv_1', '2026-09-12T03:00:00Z', 4, 2),
      duty('drv_1', '2026-09-12T03:30:00Z', 3, 3),
    ];
    const { service: hos } = makeHos(events);
    const driver = makeDriver({ homeTerminalTimezone: 'America/Chicago' });
    const service = new DriverRosterService(makeDriversRepo([driver]) as unknown as DriversRepository, hos);
    const clocks = await service.clocks('drv_1', NOW);
    expect(clocks.dutyStatus).toBe('DRIVING');
    expect(clocks.onDutySince).toBe('2026-09-12T03:00:00.000Z');
    expect(clocks.driveRemainingSec).toBe(6 * H);
    expect(clocks.shiftRemainingSec).toBe(14 * H - 5.5 * H);
    expect(clocks.breakInSec).toBe(3 * H);
    expect(clocks.statusSince).toBe('2026-09-12T03:30:00.000Z');
  });

  it('adverse driving and 60/7 limits come from the ruleset, short-haul removes nothing from the limit', async () => {
    const { service: hos } = makeHos([]);
    const driver = makeDriver({ hosRuleset: 'US_60_7_PROPERTY', adverseDrivingEnabled: true, shortHaulException: true });
    const service = new DriverRosterService(makeDriversRepo([driver]) as unknown as DriversRepository, hos);
    const clocks = await service.clocks('drv_1', new Date('2026-09-12T15:00:00Z'));
    expect(clocks).toMatchObject({ driveLimitSec: 13 * H, shiftLimitSec: 16 * H, cycleLimitSec: 60 * H, breakLimitSec: 8 * H });
  });

  it('PC shows OFF_DUTY and YM shows ON_DUTY', async () => {
    const NOW = new Date('2026-09-12T15:00:00Z');
    const pc = [duty('drv_1', '2026-09-12T13:00:00Z', 1, 1), { ...duty('drv_1', '2026-09-12T13:00:01Z', 1, 2), eventType: 3, eventCode: 1 }];
    const ym = [duty('drv_1', '2026-09-12T13:00:00Z', 4, 1), { ...duty('drv_1', '2026-09-12T13:00:01Z', 1, 2), eventType: 3, eventCode: 2 }];
    for (const [events, expected] of [[pc, 'OFF_DUTY'], [ym, 'ON_DUTY']] as const) {
      const { service: hos } = makeHos([...events]);
      const service = new DriverRosterService(makeDriversRepo([makeDriver()]) as unknown as DriversRepository, hos);
      const clocks = await service.clocks('drv_1', NOW);
      expect(clocks.dutyStatus).toBe(expected);
      expect(clocks.driveRemainingSec).toBe(11 * H);
    }
  });
});
