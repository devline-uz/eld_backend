/** LV-01 — `GET /live/fleet` latest-row probes: constant query count, recent window first. */
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../core/prisma/prisma.service';
import { LiveFleetRepository, RECENT_WINDOW_MS } from './live-fleet.repository';

const UNTIL = new Date('2026-10-15T12:10:00.000Z');
const T = new Date('2026-10-15T12:00:00.000Z');
const OLD = new Date('2026-07-01T00:00:00.000Z');

type Query = { text: string; ids: string[]; since: Date | null };

function setup(answer: (q: Query) => object[]) {
  const queries: Query[] = [];
  const $queryRaw = jest.fn((sql: Prisma.Sql) => {
    const text = sql.strings.join('?');
    const ids = sql.values[0] as string[];
    const since = (sql.values.find((v) => v instanceof Date && v.getTime() !== UNTIL.getTime()) as Date | undefined) ?? null;
    const q = { text, ids, since };
    queries.push(q);
    return Promise.resolve(answer(q));
  });
  const repo = new LiveFleetRepository({ $queryRaw } as unknown as PrismaService);
  return { repo, queries };
}

const tele = (vehicleId: string, fixTime: Date | null) => ({
  vehicleId, time: T, fixTime, latitude: fixTime ? 38.9 : null, longitude: fixTime ? -84.6 : null,
  speedMph: 0, headingDeg: 90, odometerMi: 1, engineOn: false,
});

describe('LiveFleetRepository.latestTelemetry (LV-01)', () => {
  it('answers the whole fleet with ONE windowed query when every unit reported a fix recently', async () => {
    const ids = Array.from({ length: 75 }, (_, i) => `veh_${i}`);
    const { repo, queries } = setup((q) => q.ids.map((id) => tele(id, T)));
    const res = await repo.latestTelemetry(ids, UNTIL);
    expect(queries).toHaveLength(1);
    expect(queries[0].since).toEqual(new Date(UNTIL.getTime() - RECENT_WINDOW_MS));
    expect(queries[0].text).toContain('"time" >=');
    expect(res.size).toBe(75);
  });

  it('re-probes unbounded ONLY the units without a row or a fix in the window, and keeps their older fix', async () => {
    const { repo, queries } = setup((q) => {
      if (q.since) return [tele('veh_fresh', T), tele('veh_nofix', null)];
      return q.ids.map((id) => (id === 'veh_nofix' ? { ...tele(id, OLD) } : { ...tele(id, OLD), time: OLD }));
    });
    const res = await repo.latestTelemetry(['veh_fresh', 'veh_nofix', 'veh_parked'], UNTIL);
    expect(queries).toHaveLength(2);
    expect(queries[1].since).toBeNull();
    expect(queries[1].text).not.toContain('"time" >=');
    expect(queries[1].ids).toEqual(['veh_nofix', 'veh_parked']);
    expect(res.get('veh_fresh')?.fixTime).toEqual(T);
    expect(res.get('veh_nofix')).toMatchObject({ time: T, fixTime: OLD, latitude: 38.9 });
    expect(res.get('veh_parked')).toMatchObject({ time: OLD, fixTime: OLD });
  });

  it('a unit that never had a fix keeps its newest point with fixTime null', async () => {
    const { repo } = setup(() => [tele('veh_x', null)]);
    expect((await repo.latestTelemetry(['veh_x'], UNTIL)).get('veh_x')).toMatchObject({ time: T, fixTime: null });
  });

  it('runs no query for an empty fleet', async () => {
    const { repo, queries } = setup(() => []);
    expect((await repo.latestTelemetry([], UNTIL)).size).toBe(0);
    expect(queries).toHaveLength(0);
  });
});

describe('LiveFleetRepository.latestLocatedEvents (LV-01)', () => {
  const ev = (vehicleId: string, at: Date) => ({ vehicleId, eventDateTime: at, latitude: 1, longitude: 2, locationName: 'X' });

  it('one windowed query, then an unbounded one only for the units it did not answer', async () => {
    const { repo, queries } = setup((q) => (q.since ? [ev('veh_a', T)] : q.ids.map((id) => ev(id, OLD))));
    const res = await repo.latestLocatedEvents(['veh_a', 'veh_b'], UNTIL);
    expect(queries.map((q) => [q.ids, q.since === null])).toEqual([
      [['veh_a', 'veh_b'], false],
      [['veh_b'], true],
    ]);
    expect(queries[0].text).toContain('"eventDateTime" >=');
    expect(res.get('veh_a')?.eventDateTime).toEqual(T);
    expect(res.get('veh_b')?.eventDateTime).toEqual(OLD);
  });

  it('skips the fallback when the window answered every unit', async () => {
    const { repo, queries } = setup((q) => q.ids.map((id) => ev(id, T)));
    await repo.latestLocatedEvents(['veh_a', 'veh_b'], UNTIL);
    expect(queries).toHaveLength(1);
  });
});
