/**
 * Raw-SQL time windows must not depend on the DB session `TimeZone`. App `DateTime` columns are
 * `timestamp(3)` (UTC wall clock) but Prisma binds a raw-query `Date` as `timestamptz`, so a bare
 * `"col" <= ${date}` is shifted by the session offset (+5 h on `Asia/Tashkent`). `utcTimestamp()`
 * must give the same rows under every session zone. Everything runs in a rolled-back transaction
 * against a temp table — nothing survives the test.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { utcTimestamp } from '../../src/core/prisma/sql-time';

const prisma = new PrismaClient();

class IntentionalTestRollback extends Error {}

type Probe = { fixed: string[]; bare: string[] };

/** Rows `t <= until` under the given session zone, with the helper and with a bare Date param. */
async function probe(zone: string, until: Date): Promise<Probe> {
  let out: Probe = { fixed: [], bare: [] };
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE tz_probe (id text, t timestamp(3)) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(
        `INSERT INTO tz_probe VALUES ('10:00', '2026-10-17 10:00:00'), ('12:00', '2026-10-17 12:00:00'), ('16:00', '2026-10-17 16:00:00')`,
      );
      const fixed = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM tz_probe WHERE t <= ${utcTimestamp(until)} ORDER BY t`,
      );
      const bare = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM tz_probe WHERE t <= ${until} ORDER BY t`);
      out = { fixed: fixed.map((r) => r.id), bare: bare.map((r) => r.id) };
      throw new IntentionalTestRollback();
    });
  } catch (err) {
    if (!(err instanceof IntentionalTestRollback)) throw err;
  }
  return out;
}

describe('raw SQL Date parameters vs timestamp columns (session TimeZone independence)', () => {
  afterAll(() => prisma.$disconnect());

  const until = new Date('2026-10-17T12:00:00.000Z');

  it('utcTimestamp() returns the same rows under UTC, Asia/Tashkent and America/New_York', async () => {
    const utc = await probe('UTC', until);
    const tashkent = await probe('Asia/Tashkent', until);
    const newYork = await probe('America/New_York', until);
    expect(utc.fixed).toEqual(['10:00', '12:00']);
    expect(tashkent.fixed).toEqual(utc.fixed);
    expect(newYork.fixed).toEqual(utc.fixed);
  });

  it('documents the bug: a bare Date param is skewed by the session offset', async () => {
    expect((await probe('UTC', until)).bare).toEqual(['10:00', '12:00']);
    // Tashkent (+5): the bound is read as 17:00 UTC wall clock, so the 16:00 row leaks in.
    expect((await probe('Asia/Tashkent', until)).bare).toEqual(['10:00', '12:00', '16:00']);
  });
});
