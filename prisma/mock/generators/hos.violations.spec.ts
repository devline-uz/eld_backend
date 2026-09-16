/**
 * B-064 — the hos mock generator must never delete/recreate `HosViolation` rows: ids stay stable
 * across re-runs (Notification/AuditLog references), RESOLVED rows survive, and the manager
 * resolve step is idempotent per stable key (driverId, logDate, type).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveOlderViolations } from './hos';

type Status = 'OPEN' | 'RESOLVED' | 'AUTO_CLEARED';
interface Row {
  id: string;
  driverId: string;
  logDate: Date;
  type: string;
  occurredAt: Date;
  status: Status;
  resolvedAt: Date | null;
  resolvedById: string | null;
  resolutionNote: string | null;
}

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-14T12:00:00Z');

/** Only the two calls the step may make; any create/upsert/delete would throw "not a function". */
function fakeDb(rows: Row[]) {
  const calls: string[] = [];
  const hosViolation = {
    findMany: jest.fn(async (args: { where: { driverId: { in: string[] }; status: Status; occurredAt: { lt: Date } } }) => {
      calls.push('findMany');
      const w = args.where;
      return rows
        .filter((r) => w.driverId.in.includes(r.driverId) && r.status === w.status && r.occurredAt < w.occurredAt.lt)
        .map(({ driverId, logDate, type, occurredAt }) => ({ driverId, logDate, type, occurredAt }));
    }),
    updateMany: jest.fn(async (args: { where: Pick<Row, 'driverId' | 'logDate' | 'type' | 'status'>; data: Partial<Row> }) => {
      calls.push('updateMany');
      const w = args.where;
      const hit = rows.filter(
        (r) => r.driverId === w.driverId && r.logDate.getTime() === w.logDate.getTime() && r.type === w.type && r.status === w.status,
      );
      hit.forEach((r) => Object.assign(r, args.data));
      return { count: hit.length };
    }),
  };
  return { db: { hosViolation } as never, calls, hosViolation };
}

function makeRows(n: number): Row[] {
  const types = ['DRIVING_11', 'SHIFT_14', 'BREAK_30', 'CYCLE_70'];
  return Array.from({ length: n }, (_, i) => {
    const logDate = new Date(Date.UTC(2026, 3, 1) + (i % 120) * DAY);
    return {
      id: `v-${i}`,
      driverId: `d-${i % 3}`,
      logDate,
      type: types[i % types.length],
      occurredAt: new Date(logDate.getTime() + 15 * 3600_000),
      status: 'OPEN' as Status,
      resolvedAt: null,
      resolvedById: null,
      resolutionNote: null,
    };
  });
}

const drivers = [
  { id: 'd-0', fleetManagerId: 'fm-0' },
  { id: 'd-1', fleetManagerId: null },
  { id: 'd-2', fleetManagerId: 'fm-2' },
];
const users = [{ id: 'u-1' }, { id: 'u-2' }];
const snapshot = (rows: Row[]) => JSON.stringify(rows);

describe('hos mock generator — violation idempotency (B-064)', () => {
  it('never calls hosViolation.deleteMany anywhere in hos.ts', () => {
    const src = readFileSync(join(__dirname, 'hos.ts'), 'utf8');
    expect(src).not.toMatch(/hosViolation\s*\.\s*(deleteMany|delete|create|createMany)\s*\(/);
  });

  it('resolves some old OPEN rows, and a second run changes nothing (same ids, same state)', async () => {
    const rows = makeRows(300);
    const ids = rows.map((r) => r.id);
    const { db } = fakeDb(rows);
    const first = await resolveOlderViolations(db, drivers, NOW, users);
    expect(first).toBeGreaterThan(30);
    expect(first).toBeLessThan(150);
    const after1 = snapshot(rows);
    const second = await resolveOlderViolations(db, drivers, NOW, users);
    expect(second).toBe(0);
    expect(snapshot(rows)).toBe(after1);
    expect(rows.map((r) => r.id)).toEqual(ids);
  });

  it('a lost-and-reappeared OPEN row gets the same decision (keyed draw, not list order)', async () => {
    const a = makeRows(200);
    const b = makeRows(200).reverse().filter((_, i) => i % 2 === 0);
    await resolveOlderViolations(fakeDb(a).db, drivers, NOW, users);
    await resolveOlderViolations(fakeDb(b).db, drivers, NOW, users);
    const byId = new Map(a.map((r) => [r.id, r]));
    for (const r of b) {
      const twin = byId.get(r.id)!;
      expect({ s: r.status, at: r.resolvedAt, by: r.resolvedById, note: r.resolutionNote }).toEqual({
        s: twin.status,
        at: twin.resolvedAt,
        by: twin.resolvedById,
        note: twin.resolutionNote,
      });
    }
  });

  it('never touches RESOLVED (human) or AUTO_CLEARED rows', async () => {
    const rows = makeRows(60);
    rows.forEach((r, i) => {
      if (i % 2 === 0) Object.assign(r, { status: 'RESOLVED', resolvedAt: new Date(NOW - 20 * DAY), resolvedById: 'human', resolutionNote: 'kept' });
      else r.status = 'AUTO_CLEARED';
    });
    const before = snapshot(rows);
    const { db, hosViolation } = fakeDb(rows);
    expect(await resolveOlderViolations(db, drivers, NOW, users)).toBe(0);
    expect(hosViolation.updateMany).not.toHaveBeenCalled();
    expect(snapshot(rows)).toBe(before);
  });

  it('leaves violations younger than 10 days OPEN and writes only by the stable key', async () => {
    const rows = makeRows(40).map((r) => ({ ...r, occurredAt: new Date(NOW - 5 * DAY) }));
    const { db, calls } = fakeDb(rows);
    expect(await resolveOlderViolations(db, drivers, NOW, users)).toBe(0);
    expect(calls).toEqual(['findMany']);
    const old = makeRows(40);
    const f = fakeDb(old);
    await resolveOlderViolations(f.db, drivers, NOW, users);
    for (const [args] of f.hosViolation.updateMany.mock.calls) {
      expect(Object.keys(args.where).sort()).toEqual(['driverId', 'logDate', 'status', 'type']);
      expect(args.where.status).toBe('OPEN');
    }
  });

  it('stamps resolvedAt within [occurredAt, now - 1h] and uses the fleet manager when set', async () => {
    const rows = makeRows(300);
    await resolveOlderViolations(fakeDb(rows).db, drivers, NOW, users);
    for (const r of rows.filter((x) => x.status === 'RESOLVED')) {
      expect(r.resolvedAt!.getTime()).toBeGreaterThan(r.occurredAt.getTime());
      expect(r.resolvedAt!.getTime()).toBeLessThanOrEqual(NOW - 3600_000);
      if (r.driverId === 'd-0') expect(r.resolvedById).toBe('fm-0');
      if (r.driverId === 'd-1') expect(['u-1', 'u-2']).toContain(r.resolvedById);
    }
  });
});
