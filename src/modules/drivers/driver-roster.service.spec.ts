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

function makeDriversRepo(items: Array<ReturnType<typeof makeDriver>>, open: Record<string, number> = {}, adverseInvoked: string[] = []) {
  return {
    listRoster: jest.fn().mockResolvedValue({ items, total: items.length }),
    rosterSummary: jest.fn().mockResolvedValue({ total: items.length, withActiveViolations: Object.keys(open).length }),
    countOpenViolations: jest.fn(async () => new Map(Object.entries(open))),
    findById: jest.fn(async ({ id }: { id: string }) => items.find((d) => d.id === id) ?? null),
    findAdverseInvokedToday: jest.fn(async () => new Set(adverseInvoked)),
    upsertAdverseInvocation: jest.fn(async (data: Record<string, unknown>) => ({ id: 'adv_1', createdAt: new Date('2026-09-12T15:00:00Z'), ...data })),
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

    expect(Object.keys(page).sort()).toEqual(['items', 'limit', 'page', 'summary', 'total', 'totalPages']);
    expect(page.summary).toEqual({ total: 2, withActiveViolations: 1 });
    expect(page).toMatchObject({ page: 1, limit: 25, total: 2, totalPages: 1 });
    const [first, second] = page.items;
    expect(Object.keys(first).sort()).toEqual(['driver', 'dutyStatus', 'emailVerified', 'hos', 'isStale', 'limits', 'openViolations', 'staleSince', 'unit']);
    expect(first.limits).toEqual({ driveLimitSec: 11 * H, shiftLimitSec: 14 * H, cycleLimitSec: 70 * H });
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
      hosRuleset: 'US_70_8_PROPERTY',
    });
    expect(first.dutyStatus).toBe('DRIVING');
    expect(first.unit).toEqual({ id: 'veh_1', unitNumber: '101' });
    expect(first.openViolations).toBe(2);
    // has an email on file but no `emailVerifiedAt` yet (§20 B-31).
    expect(first.emailVerified).toBe(false);
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

  it('UI-015 — the hasOpenViolation segment and the global summary use the ActiveViolationsService exclusions', async () => {
    const drivers = makeDriversRepo([]);
    const { service: hos } = makeHos([]);
    const exclude = [{ NOT: { driverId: 'drv_9', occurredAt: { gt: new Date('2026-09-11T02:00:00Z') } } }];
    const activeViolations = { refresh: jest.fn().mockResolvedValue(exclude), openCountsByDriver: jest.fn().mockResolvedValue(new Map()) };
    drivers.rosterSummary.mockResolvedValue({ total: 12, withActiveViolations: 3 });
    const service = new DriverRosterService(drivers as unknown as DriversRepository, hos, undefined, activeViolations as never);
    const page = await service.roster(query({ hasOpenViolation: 'true', q: 'smith' }), NOW);
    expect(drivers.listRoster).toHaveBeenCalledWith(
      { status: undefined, q: 'smith', terminal: undefined, hasOpenViolation: true, exempt: undefined, violationExclude: exclude },
      1,
      25,
      { lastName: 'asc' },
    );
    // The header count ignores the current filter / search.
    expect(drivers.rosterSummary).toHaveBeenCalledWith(exclude);
    expect(page.summary).toEqual({ total: 12, withActiveViolations: 3 });
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

describe('DriverRosterService — invalid stored timezone (BE-003)', () => {
  const NOW = new Date('2026-09-12T15:00:00Z');
  const events = [duty('drv_1', '2026-09-12T10:00:00Z', 3, 1)];

  it('roster skips only the driver with an invalid zone; everyone else keeps engine clocks', async () => {
    const bad = makeDriver({ id: 'drv_bad', homeTerminalTimezone: 'Mars/Olympus_Mons' });
    const drivers = makeDriversRepo([makeDriver(), bad]);
    const { service: hos } = makeHos(events);
    const spy = jest.spyOn(hos, 'computeCurrentStates');
    const service = new DriverRosterService(drivers as unknown as DriversRepository, hos);
    const page = await service.roster(query(), NOW);
    expect((spy.mock.calls[0][0] as Array<{ id: string }>).map((d) => d.id)).toEqual(['drv_1']);
    expect(page.items.map((i) => [i.driver.id, i.dutyStatus])).toEqual([
      ['drv_1', 'DRIVING'],
      ['drv_bad', 'OFF_DUTY'],
    ]);
  });

  it('clocks answers 503 for a driver with an invalid zone instead of crashing', async () => {
    const drivers = makeDriversRepo([makeDriver({ homeTerminalTimezone: 'Not/AZone' })]);
    const { service: hos } = makeHos(events);
    const service = new DriverRosterService(drivers as unknown as DriversRepository, hos);
    await expect(service.clocks('drv_1', NOW)).rejects.toMatchObject({ status: 503 });
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
      hosRuleset: 'US_70_8_PROPERTY',
      dutyStatus: 'OFF_DUTY',
      statusSince: NOW.toISOString(),
      computedAt: NOW.toISOString(),
      isStale: false,
      staleSince: null,
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

  it('adverse driving (invoked today) and 60/7 limits come from the ruleset, short-haul removes nothing from the limit', async () => {
    const { service: hos } = makeHos([]);
    const driver = makeDriver({ hosRuleset: 'US_60_7_PROPERTY', adverseDrivingEnabled: true, shortHaulException: true });
    const service = new DriverRosterService(makeDriversRepo([driver], {}, ['drv_1']) as unknown as DriversRepository, hos);
    const clocks = await service.clocks('drv_1', new Date('2026-09-12T15:00:00Z'));
    expect(clocks).toMatchObject({ driveLimitSec: 13 * H, shiftLimitSec: 16 * H, cycleLimitSec: 60 * H, breakLimitSec: 8 * H });
  });

  it('BUG-001: adverseDrivingEnabled alone is only a permission — no +2 h until it is invoked for the day', async () => {
    // 10 h off, ON 06:00 local, driving 07:00-19:00 local (12 h), now 19:00 local.
    const NOW = new Date('2026-09-12T23:00:00Z');
    const events = [duty('drv_1', '2026-09-11T20:00:00Z', 1, 1), duty('drv_1', '2026-09-12T10:00:00Z', 4, 2), duty('drv_1', '2026-09-12T11:00:00Z', 3, 3)];
    const driver = makeDriver({ adverseDrivingEnabled: true });

    const plain = new DriverRosterService(makeDriversRepo([driver]) as unknown as DriversRepository, makeHos(events).service);
    expect(await plain.clocks('drv_1', NOW)).toMatchObject({ driveLimitSec: 11 * H, shiftLimitSec: 14 * H, driveRemainingSec: 0 });
    const [entry] = (await plain.roster(query(), NOW)).items;
    expect(entry.limits).toEqual({ driveLimitSec: 11 * H, shiftLimitSec: 14 * H, cycleLimitSec: 70 * H });
    expect(entry.hos.driveRemainingSec).toBe(0);

    const invoked = new DriverRosterService(makeDriversRepo([driver], {}, ['drv_1']) as unknown as DriversRepository, makeHos(events).service);
    expect(await invoked.clocks('drv_1', NOW)).toMatchObject({ driveLimitSec: 13 * H, shiftLimitSec: 16 * H, driveRemainingSec: 1 * H });
    expect((await invoked.roster(query(), NOW)).items[0].limits).toEqual({ driveLimitSec: 13 * H, shiftLimitSec: 16 * H, cycleLimitSec: 70 * H });
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

describe('DriverRosterService — BUG-002 stuck duty status', () => {
  // DRIVING since 2026-10-08T08:28Z with no further event; "today" is four days later.
  const SINCE = '2026-10-08T08:28:00Z';
  const NOW = new Date('2026-10-12T12:00:00Z');
  const events = [duty('drv_1', '2026-10-07T20:00:00Z', 1, 1), duty('drv_1', SINCE, 3, 2)];
  const makeQueue = () => ({ add: jest.fn().mockResolvedValue({}) });

  it('freezes the clocks at the 16 h DRIVING cap, flags the status stale and alerts once', async () => {
    const { service: hos } = makeHos(events);
    const queue = makeQueue();
    const service = new DriverRosterService(makeDriversRepo([makeDriver()]) as unknown as DriversRepository, hos, queue as never);

    const clocks = await service.clocks('drv_1', NOW);
    expect(clocks).toMatchObject({ dutyStatus: 'DRIVING', statusSince: '2026-10-08T08:28:00.000Z', isStale: true, staleSince: '2026-10-09T00:28:00.000Z' });
    // Cycle is counted only up to the cap (16 h), not four days.
    expect(clocks.cycleRemainingSec).toBe(70 * H - 16 * H);

    await service.clocks('drv_1', new Date('2026-10-12T12:05:00Z'));
    await service.roster(query(), NOW);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'alert.eld_status_stale',
      expect.objectContaining({ driverId: 'drv_1', dutyStatus: 'DRIVING', staleSince: '2026-10-09T00:28:00.000Z', title: 'ELD connection lost' }),
      expect.objectContaining({ jobId: `hos-status-stale-drv_1-${new Date(SINCE).getTime()}` }),
    );
  });

  it('marks the roster row stale', async () => {
    const { service: hos } = makeHos(events);
    const service = new DriverRosterService(makeDriversRepo([makeDriver()]) as unknown as DriversRepository, hos, makeQueue() as never);
    const page = await service.roster(query(), NOW);
    expect(page.items[0]).toMatchObject({ dutyStatus: 'DRIVING', isStale: true, staleSince: '2026-10-09T00:28:00.000Z' });
  });

  it('a driving status under the cap is not stale and raises nothing', async () => {
    const { service: hos } = makeHos(events);
    const queue = makeQueue();
    const service = new DriverRosterService(makeDriversRepo([makeDriver()]) as unknown as DriversRepository, hos, queue as never);
    const clocks = await service.clocks('drv_1', new Date('2026-10-08T15:00:00Z'));
    expect(clocks).toMatchObject({ isStale: false, staleSince: null });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a long OFF_DUTY (home time) is never stale', async () => {
    const { service: hos } = makeHos([duty('drv_1', '2026-10-01T00:00:00Z', 1, 1)]);
    const service = new DriverRosterService(makeDriversRepo([makeDriver()]) as unknown as DriversRepository, hos, makeQueue() as never);
    const clocks = await service.clocks('drv_1', NOW);
    expect(clocks).toMatchObject({ dutyStatus: 'OFF_DUTY', isStale: false });
  });

  it('a failed enqueue does not fail the read and is retried on the next request', async () => {
    const { service: hos } = makeHos(events);
    const queue = { add: jest.fn().mockRejectedValueOnce(new Error('redis down')).mockResolvedValue({}) };
    const service = new DriverRosterService(makeDriversRepo([makeDriver()]) as unknown as DriversRepository, hos, queue as never);
    await expect(service.clocks('drv_1', NOW)).resolves.toMatchObject({ isStale: true });
    await service.clocks('drv_1', NOW);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});

describe('DriverRosterService.invokeAdverseDriving (BUG-001)', () => {
  const NOW = new Date('2026-09-12T15:00:00Z');
  const actor = { id: 'usr_1', type: 'user' as const };

  it('records the annotated invocation for the driver\'s current RODS day by default', async () => {
    const drivers = makeDriversRepo([makeDriver({ adverseDrivingEnabled: true })]);
    const service = new DriverRosterService(drivers as unknown as DriversRepository, makeHos([]).service);
    const res = await service.invokeAdverseDriving('drv_1', { annotation: 'Unforeseen snow on I-80' }, actor, NOW);
    expect(drivers.upsertAdverseInvocation).toHaveBeenCalledWith({
      driverId: 'drv_1',
      logDate: new Date('2026-09-12T00:00:00.000Z'),
      annotation: 'Unforeseen snow on I-80',
      invokedById: 'usr_1',
      invokedByType: 'user',
    });
    expect(res).toMatchObject({ driverId: 'drv_1', date: '2026-09-12', annotation: 'Unforeseen snow on I-80' });
  });

  it('refuses a driver without the permission, a future day and an unknown driver', async () => {
    const service = new DriverRosterService(makeDriversRepo([makeDriver()]) as unknown as DriversRepository, makeHos([]).service);
    await expect(service.invokeAdverseDriving('drv_1', { annotation: 'Fog bank' }, actor, NOW)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.invokeAdverseDriving('nope', { annotation: 'Fog bank' }, actor, NOW)).rejects.toBeInstanceOf(AppException);
    const permitted = new DriverRosterService(makeDriversRepo([makeDriver({ adverseDrivingEnabled: true })]) as unknown as DriversRepository, makeHos([]).service);
    await expect(permitted.invokeAdverseDriving('drv_1', { annotation: 'Fog bank', date: '2026-09-13' }, actor, NOW)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
