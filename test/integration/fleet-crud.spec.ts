/**
 * Phase 2 — Fleet (TZ §5.3, §5.4, §4.3). Exercises the exact Prisma shapes
 * `VehiclesService`/`DriversService`/`DevicesService` write, against the real dev DB, so a
 * schema/enum mismatch that mocked unit tests can't see (e.g. a renamed field) fails here
 * instead of in production.
 *
 * Runs entirely inside one `$transaction` that always rolls back (throws a sentinel at the
 * end) so it never leaves rows behind to clean up — see bugs.md B-009: a real hard `DELETE`
 * of `Vehicle`/`Driver`/`Device` is broken fleet-wide by the append-only `REVOKE` on
 * `EldEvent` (repro'd even as the Postgres superuser), so this suite never relies on one.
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

class RollbackSentinel extends Error {}

async function inRolledBackTransaction(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new RollbackSentinel();
    });
  } catch (err) {
    if (err instanceof RollbackSentinel) return;
    throw err;
  }
}

describe('Fleet CRUD — vehicles, drivers, devices (Phase 2)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates a vehicle with the TZ §4.3 odometer fields, calibrates it, assigns a driver, and pairs a device', async () => {
    await inRolledBackTransaction(async (tx) => {
      const unitNumber = `TEST-${Date.now()}`;
      const vin = `1TESTVIN${Date.now()}`.slice(0, 17);

      const vehicle = await tx.vehicle.create({ data: { unitNumber, vin, fuelType: 'DIESEL', odometerMi: 23100 } });
      expect(vehicle.odometerOffsetMi).toBe(0);
      expect(vehicle.odometerCalibratedAt).toBeNull();

      // Simulate the first PT30 reading landing (ingest, Phase 3) before calibration runs.
      await tx.vehicle.update({ where: { id: vehicle.id }, data: { deviceOdometerMi: 5056 } });
      const calibrated = await tx.vehicle.update({
        where: { id: vehicle.id },
        data: { odometerOffsetMi: 23100 - 5056, odometerCalibratedAt: new Date() },
      });
      expect(calibrated.odometerOffsetMi).toBe(18044);
      expect(calibrated.odometerCalibratedAt).not.toBeNull();

      const driver = await tx.driver.create({
        data: {
          username: `test_driver_${Date.now()}`,
          passwordHash: 'x',
          firstName: 'Test',
          lastName: 'Driver',
          cdlNumber: 'D0000001',
          cdlState: 'OH',
          homeTerminalName: 'Columbus, OH',
          assignedVehicle: { connect: { id: vehicle.id } },
        },
      });
      expect(driver.assignedVehicleId).toBe(vehicle.id);

      const device = await tx.device.create({
        data: {
          serial: `PT30_TEST_${Date.now()}`,
          model: 'PT30',
          firmware: 'L113',
          vehicle: { connect: { id: vehicle.id } },
          status: 'ASSIGNED',
          pairedAt: new Date(),
        },
      });
      expect(device.vehicleId).toBe(vehicle.id);

      // One device per unit (hard rule). NOTE: Prisma's `connect` on an optional 1:1 relation
      // implements "steal" semantics — it silently disconnects the previous holder via an
      // `UPDATE ... SET "vehicleId" = NULL` before inserting, rather than ever hitting the
      // `@@unique(["vehicleId"])` index (verified against pg_indexes: `Device_vehicleId_key`
      // exists as a real unique btree index — see decisions.md). That's exactly why
      // `DevicesService.pair()` never relies on the DB to reject a double-pair: it does its
      // own `findByVehicleId` check first and throws `DEVICE_ALREADY_PAIRED` (unit-tested in
      // `devices.service.spec.ts`) before ever calling `connect`.
      const stolen = await tx.device.create({
        data: { serial: `${device.serial}_dup`, model: 'PT30', vehicle: { connect: { id: vehicle.id } } },
      });
      expect(stolen.vehicleId).toBe(vehicle.id);
      const original = await tx.device.findUniqueOrThrow({ where: { id: device.id } });
      expect(original.vehicleId).toBeNull(); // silently stolen, not rejected — the app-level guard is load-bearing

      // Soft-delete only (bugs.md B-009): a plain status UPDATE, never `.delete()`.
      const retired = await tx.device.update({ where: { id: device.id }, data: { vehicle: { disconnect: true }, status: 'RETIRED' } });
      expect(retired.status).toBe('RETIRED');
      expect(retired.vehicleId).toBeNull();

      const terminated = await tx.driver.update({ where: { id: driver.id }, data: { assignedVehicle: { disconnect: true }, status: 'TERMINATED' } });
      expect(terminated.status).toBe('TERMINATED');
      expect(terminated.assignedVehicleId).toBeNull();

      const deactivated = await tx.vehicle.update({ where: { id: vehicle.id }, data: { status: 'INACTIVE' } });
      expect(deactivated.status).toBe('INACTIVE');
    });
  });

  it('soft-deletes a DVIR-referenced trailer and frees its number (migration 20261007110000_trailer_soft_delete)', async () => {
    await inRolledBackTransaction(async (tx) => {
      const stamp = Date.now();
      const number = `TRL-TEST-${stamp}`;
      const vehicle = await tx.vehicle.create({ data: { unitNumber: `TEST-T-${stamp}`, vin: `1TRLVIN${stamp}`.slice(0, 17), fuelType: 'DIESEL' } });
      const driver = await tx.driver.create({
        data: { username: `test_trl_${stamp}`, passwordHash: 'x', firstName: 'Test', lastName: 'Trailer', cdlNumber: `T${stamp}`, cdlState: 'OH', homeTerminalName: 'Columbus, OH' },
      });
      const trailer = await tx.trailer.create({ data: { number } });
      const dvir = await tx.dvir.create({
        data: {
          driverId: driver.id,
          vehicleId: vehicle.id,
          trailerId: trailer.id,
          type: 'PRE_TRIP',
          submittedAt: new Date(),
          odometerMi: 1000,
          vehicleCondition: 'SATISFACTORY',
          driverSignatureUrl: 'signatures/test.png',
        },
      });

      // What `TrailersService.remove` writes — an UPDATE, so the Dvir FK (ON DELETE RESTRICT) never fires.
      await tx.trailer.update({ where: { id: trailer.id }, data: { status: 'INACTIVE', deletedAt: new Date() } });

      // History still resolves the deleted trailer, with deletedAt visible.
      const history = await tx.dvir.findUniqueOrThrow({ where: { id: dvir.id }, include: { trailer: true } });
      expect(history.trailer?.number).toBe(number);
      expect(history.trailer?.deletedAt).toBeInstanceOf(Date);

      // Live-only reads (TrailersRepository.findByNumber / list) no longer see it.
      expect(await tx.trailer.findFirst({ where: { number, deletedAt: null } })).toBeNull();

      // The partial unique index lets a NEW live trailer take the number...
      const reused = await tx.trailer.create({ data: { number } });
      expect(reused.id).not.toBe(trailer.id);
      expect(await tx.trailer.count({ where: { number } })).toBe(2);

      // ...but still rejects a second LIVE one (last statement: P2002 aborts the transaction).
      await expect(tx.trailer.create({ data: { number } })).rejects.toMatchObject({ code: 'P2002' });
    });
  });
});
