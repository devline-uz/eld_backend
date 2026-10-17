import { Prisma } from '@prisma/client';
import { utcTimestamp } from './sql-time';

describe('utcTimestamp', () => {
  const at = new Date('2026-10-17T12:00:00.000Z');

  it('binds the Date as one parameter and converts it to a UTC timestamp', () => {
    const sql = utcTimestamp(at);
    expect(sql.values).toEqual([at]);
    expect(sql.text).toBe(`($1::timestamptz AT TIME ZONE 'UTC')`);
  });

  it('keeps the column side bare when embedded in a comparison', () => {
    const sql = Prisma.sql`SELECT 1 FROM "TelemetryPoint" WHERE "time" <= ${utcTimestamp(at)} AND "vehicleId" = ${'veh'}`;
    expect(sql.text).toBe(`SELECT 1 FROM "TelemetryPoint" WHERE "time" <= ($1::timestamptz AT TIME ZONE 'UTC') AND "vehicleId" = $2`);
    expect(sql.values).toEqual([at, 'veh']);
  });
});
