/** D-130 — server-written §395 Appendix A 4.5.1.5 login/logout records (eventType 5). */
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../core/prisma/prisma.service';
import { IngestRepository } from '../ingest/ingest.repository';
import { RodsLoginRecorder } from './rods-login-recorder';

const AT = new Date('2026-10-08T15:00:00.000Z');

function build(open: { eventCode: number; vehicleId: string | null } | null) {
  const inserted: Prisma.EldEventCreateManyInput[] = [];
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    eldEvent: {
      findFirst: jest.fn(async (args: { where: { eventType?: number } }) =>
        args.where.eventType === 5
          ? open
          : { totalVehicleMiles: 120345, totalEngineHours: 5321.4, latitude: 41.3, longitude: -72.9, locationPrecisionMi: 1 },
      ),
    },
    driver: { findUnique: jest.fn().mockResolvedValue({ homeTerminalTimezone: 'America/Chicago' }) },
    device: { findFirst: jest.fn().mockResolvedValue({ id: 'dev_1' }) },
    vehicle: { findUnique: jest.fn().mockResolvedValue({ odometerMi: 0, engineHours: 0 }) },
  };
  const prisma = { $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)) };
  jest.spyOn(IngestRepository.prototype, 'allocateSequenceIds').mockImplementation(async (_tx, _key, count) =>
    Array.from({ length: count }, (_, i) => 41 + i),
  );
  jest.spyOn(IngestRepository.prototype, 'ensurePartitions').mockResolvedValue(undefined);
  jest.spyOn(IngestRepository.prototype, 'insertEvents').mockImplementation(async (_tx, rows) => {
    inserted.push(...rows);
    return rows.length;
  });
  const recorder = new RodsLoginRecorder(prisma as unknown as PrismaService);
  return { recorder, tx, prisma, inserted };
}

afterEach(() => jest.restoreAllMocks());

describe('RodsLoginRecorder.login (D-130)', () => {
  it('writes one eventType 5 code 1 record, origin 1 / status 1, with the unit device and last reading', async () => {
    const { recorder, inserted, tx } = build(null);
    expect(await recorder.login('drv_1', 'veh_1', 'SELECT_VEHICLE', AT)).toBe(1);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), 'eldlogin:drv_1');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      driverId: 'drv_1',
      vehicleId: 'veh_1',
      deviceId: 'dev_1',
      eventType: 5,
      eventCode: 1,
      eventSequenceId: 41,
      eventDateTime: AT,
      timezoneOffset: -300, // CDT
      recordStatus: 1,
      recordOrigin: 1,
      totalVehicleMiles: 120345,
      totalEngineHours: 5321.4,
    });
    expect(inserted[0].checksum).toMatch(/^[0-9a-f]{16}$/);
    expect(inserted[0].editedById).toBeUndefined();
  });

  it('is idempotent: no second login while one is open on the same unit', async () => {
    const { recorder, inserted } = build({ eventCode: 1, vehicleId: 'veh_1' });
    expect(await recorder.login('drv_1', 'veh_1', 'AUTH_LOGIN', AT)).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it('closes an open login on another unit first (logout 1 ms earlier, then login)', async () => {
    const { recorder, inserted } = build({ eventCode: 1, vehicleId: 'veh_old' });
    expect(await recorder.login('drv_1', 'veh_1', 'SELECT_VEHICLE', AT)).toBe(2);
    expect(inserted.map((r) => [r.eventCode, r.vehicleId, (r.eventDateTime as Date).getTime()])).toEqual([
      [2, 'veh_old', AT.getTime() - 1],
      [1, 'veh_1', AT.getTime()],
    ]);
  });

  it('uses the vehicle odometer when the unit has no recent reading', async () => {
    const { recorder, inserted, tx } = build(null);
    tx.eldEvent.findFirst.mockResolvedValue(null); // no open login and no recent reading
    tx.vehicle.findUnique.mockResolvedValue({ odometerMi: 99000, engineHours: 0 });
    await recorder.login('drv_1', 'veh_1', 'AUTH_LOGIN', AT);
    expect(inserted[0]).toMatchObject({ totalVehicleMiles: 99000, totalEngineHours: null, latitude: null, longitude: null });
  });
});

describe('RodsLoginRecorder.logout (D-130)', () => {
  it('writes code 2 on the unit of the open login', async () => {
    const { recorder, inserted } = build({ eventCode: 1, vehicleId: 'veh_1' });
    expect(await recorder.logout('drv_1', 'AUTH_LOGOUT', {}, AT)).toBe(1);
    expect(inserted[0]).toMatchObject({ eventType: 5, eventCode: 2, vehicleId: 'veh_1', recordOrigin: 1, recordStatus: 1 });
  });

  it.each([
    ['no login record at all', null],
    ['the latest record is already a logout', { eventCode: 2, vehicleId: 'veh_1' }],
  ])('never writes a logout without an open login (%s)', async (_label, open) => {
    const { recorder, inserted } = build(open);
    expect(await recorder.logout('drv_1', 'AUTH_LOGOUT', {}, AT)).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it('respects onlyVehicleId (an open login on another unit is left alone)', async () => {
    const { recorder, inserted } = build({ eventCode: 1, vehicleId: 'veh_2' });
    expect(await recorder.logout('drv_1', 'RELEASE_VEHICLE', { onlyVehicleId: 'veh_1' }, AT)).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it('never throws: a failing write is logged and reported as 0 records', async () => {
    const { recorder, prisma } = build(null);
    prisma.$transaction.mockRejectedValueOnce(new Error('db down'));
    await expect(recorder.logout('drv_1', 'AUTH_LOGOUT', {}, AT)).resolves.toBe(0);
  });
});
