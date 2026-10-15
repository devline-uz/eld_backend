import { scheduleCandidateFilters, TripsRepository } from './trips.repository';

/** Minimal evaluator for the Prisma `where` operators the schedule pre-filter uses. */
type Row = Record<string, unknown>;
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (typeof cond !== 'object' || cond instanceof Date) return value === cond;
    const ops = cond as Record<string, unknown>;
    return Object.entries(ops).every(([op, arg]) => {
      if (op === 'in') return (arg as unknown[]).includes(value);
      if (op === 'not') return arg === null ? value !== null && value !== undefined : value !== arg;
      if (value === null || value === undefined) return false;
      if (op === 'lt') return (value as Date).getTime() < (arg as Date).getTime();
      if (op === 'gt') return (value as Date).getTime() > (arg as Date).getTime();
      throw new Error(`unsupported op ${op}`);
    });
  });
}

const at = (day: number, h = 0) => new Date(Date.UTC(2026, 9, day, h));
const trip = (o: Row): Row => ({
  id: 't',
  status: 'PLANNED',
  plannedStartAt: null,
  plannedEndAt: null,
  startedAt: null,
  completedAt: null,
  ...o,
});

describe('TripsRepository — schedule candidate pre-filter (BE-002)', () => {
  const window = { start: at(20, 10), end: at(20, 14) };
  const keep = (row: Row) => scheduleCandidateFilters(window).some((w) => matches(row, w));

  it('drops an old DELIVERED trip with no planned end (no longer treated as open-ended)', () => {
    expect(keep(trip({ status: 'DELIVERED', plannedStartAt: at(1), startedAt: at(1), completedAt: at(2) }))).toBe(false);
    expect(keep(trip({ status: 'DELIVERED', plannedStartAt: at(1) }))).toBe(false);
  });

  it('keeps a DELIVERED trip whose actual run overlaps the window', () => {
    expect(keep(trip({ status: 'DELIVERED', startedAt: at(20, 9), completedAt: at(20, 11) }))).toBe(true);
    expect(keep(trip({ status: 'DELIVERED', plannedStartAt: at(20, 9), plannedEndAt: at(20, 11) }))).toBe(true);
  });

  it('keeps overlapping scheduled trips (open-ended included) and drops past / future ones', () => {
    expect(keep(trip({ status: 'ASSIGNED', plannedStartAt: at(20, 12), plannedEndAt: at(20, 18) }))).toBe(true);
    expect(keep(trip({ status: 'PLANNED', plannedStartAt: at(19) }))).toBe(true);
    expect(keep(trip({ status: 'DRAFT', plannedStartAt: at(19), plannedEndAt: at(19, 5) }))).toBe(false);
    expect(keep(trip({ status: 'PLANNED', plannedStartAt: at(21) }))).toBe(false);
    expect(keep(trip({ status: 'PLANNED' }))).toBe(false);
  });

  it('always keeps IN_PROGRESS and never CANCELLED', () => {
    expect(keep(trip({ status: 'IN_PROGRESS', startedAt: at(1) }))).toBe(true);
    expect(keep(trip({ status: 'CANCELLED', plannedStartAt: at(20, 11), plannedEndAt: at(20, 12) }))).toBe(false);
  });

  it('queries without a row cap, so a real conflict is never cut off behind stale rows', async () => {
    const db = { trip: { findMany: jest.fn(async () => []) } };
    const repo = new TripsRepository({} as never);
    await repo.findDriverScheduleCandidates('drv_1', window, 'trp_self', db as never);
    const args = (db.trip.findMany.mock.calls[0] as unknown[])[0] as Row;
    expect(args).not.toHaveProperty('take');
    expect(args.where).toMatchObject({ driverId: 'drv_1', id: { not: 'trp_self' } });
  });
});

describe('TripsRepository — update moves the endpoint stops (FE-15)', () => {
  function build() {
    const tx = {
      trip: { update: jest.fn(async () => ({ id: 'trp_1' })) },
      tripStop: {
        findFirst: jest.fn(async (args: { where: { type: string } }) => ({ id: args.where.type === 'PICKUP' ? 'stop_first' : 'stop_last' })),
        update: jest.fn(async () => ({})),
      },
    };
    const prisma = { trip: tx.trip, $transaction: jest.fn(async (work: (t: unknown) => unknown) => work(tx)) };
    return { repo: new TripsRepository(prisma as never), prisma, tx };
  }

  it('sets the first PICKUP and last DELIVERY scheduledAt in one transaction', async () => {
    const { repo, prisma, tx } = build();
    const pickupAt = at(22, 8);
    const deliveryAt = at(23, 8);
    await repo.update({ id: 'trp_1' }, { plannedStartAt: pickupAt, plannedEndAt: deliveryAt }, undefined, { pickupAt, deliveryAt });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.tripStop.findFirst).toHaveBeenCalledWith({ where: { tripId: 'trp_1', type: 'PICKUP' }, orderBy: { sequence: 'asc' }, select: { id: true } });
    expect(tx.tripStop.findFirst).toHaveBeenCalledWith({ where: { tripId: 'trp_1', type: 'DELIVERY' }, orderBy: { sequence: 'desc' }, select: { id: true } });
    expect(tx.tripStop.update).toHaveBeenCalledWith({ where: { id: 'stop_first' }, data: { scheduledAt: pickupAt } });
    expect(tx.tripStop.update).toHaveBeenCalledWith({ where: { id: 'stop_last' }, data: { scheduledAt: deliveryAt } });
  });

  it('only moves the delivery stop when only the end changed, using the outer transaction', async () => {
    const { repo, prisma, tx } = build();
    await repo.update({ id: 'trp_1' }, {}, tx as never, { deliveryAt: at(23) });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.tripStop.update).toHaveBeenCalledTimes(1);
    expect(tx.tripStop.update).toHaveBeenCalledWith({ where: { id: 'stop_last' }, data: { scheduledAt: at(23) } });
  });

  it('skips a route without that stop', async () => {
    const { repo, tx } = build();
    tx.tripStop.findFirst.mockResolvedValueOnce(null as never);
    await repo.update({ id: 'trp_1' }, {}, tx as never, { pickupAt: at(22) });
    expect(tx.tripStop.update).not.toHaveBeenCalled();
  });
});
