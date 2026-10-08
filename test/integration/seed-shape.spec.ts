/**
 * tz.md §22.3.6 — the dev DB seed must reproduce the Figma demo dataset shape. This does
 * NOT re-run the seed (that is `npm run db:seed`'s job) — it asserts against whatever is
 * currently in the dev DB, so it also serves as a regression check after `db:reset:dev`.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * B-012 — ad-hoc debugging against `onebook_eld_dev` (never through this suite; `Vehicle` /
 * `Driver` / `Device` hard-deletes are broken fleet-wide by B-009's append-only `REVOKE`, so
 * nothing here can clean them up) has left stray rows with these recognizable prefixes:
 * `TEST-*` / `DBG2-*` vehicles, `test_driver_*` drivers, `PT30_TEST_*` devices, and
 * `E2E_AUDIT_ROLE_*` roles (the last one is now prevented going forward — see
 * `test/e2e/audit-before-after.e2e-spec.ts`).
 *
 * This spec's job is to check the *seeded* Figma demo dataset shape (tz.md §22.3.6), not
 * "however many rows happen to be in the dev DB right now regardless of who put them there".
 * Filtering these known non-seed prefixes out of the counts keeps the assertion exact for its
 * actual subject instead of either loosening it (accepting any count >= N, which would silently
 * tolerate a broken seed too) or leaving it permanently red until someone runs
 * `db:reset:dev && db:seed` by hand.
 */
const NOT_LEAKED_ROLE = { key: { not: { startsWith: 'E2E_AUDIT_ROLE_' } } };
const NOT_LEAKED_VEHICLE = {
  unitNumber: { not: { startsWith: 'TEST-' } },
  AND: [{ unitNumber: { not: { startsWith: 'DBG2-' } } }],
};
const NOT_LEAKED_DRIVER = { username: { not: { startsWith: 'test_driver_' } } };

describe('seed shape matches tz.md §22.3.6 (Figma demo dataset)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('Carrier is Universal Logistics Inc., DOT #1234567', async () => {
    const carrier = await prisma.carrier.findUnique({ where: { id: 'carrier' } });
    expect(carrier?.name).toBe('Universal Logistics Inc.');
    expect(carrier?.dotNumber).toBe('1234567');
    expect(carrier?.eldIdentifier).toBe('OBK001'); // Appendix A 7.15 — 6 chars (B-138)
  });

  it('has 4 roles and 12 users, including admin Sarah Chen', async () => {
    expect(await prisma.role.count({ where: NOT_LEAKED_ROLE })).toBe(4);
    expect(await prisma.user.count()).toBe(12);
    const sarah = await prisma.user.findUnique({
      where: { email: 'sarah.chen@universal-logistics.example' },
      include: { role: true },
    });
    expect(sarah?.firstName).toBe('Sarah');
    expect(sarah?.lastName).toBe('Chen');
    expect(sarah?.role.key).toBe('ADMIN');
  });

  it('has 69 vehicles, including unit #101 (Freightliner Cascadia) and unit #110 OUT_OF_SERVICE', async () => {
    expect(await prisma.vehicle.count({ where: NOT_LEAKED_VEHICLE })).toBe(69);
    const unit101 = await prisma.vehicle.findFirst({ where: { unitNumber: '101', deletedAt: null } });
    expect(unit101?.make).toBe('Freightliner');
    expect(unit101?.model).toBe('Cascadia');
    expect(unit101?.vin).toBe('1FUJGLDR8LLLL1234');

    const unit110 = await prisma.vehicle.findFirst({ where: { unitNumber: '110', deletedAt: null } });
    expect(unit110?.status).toBe('OUT_OF_SERVICE');
    const openCriticalDefect = await prisma.defect.findFirst({
      where: { vehicleId: unit110?.id, severity: 'CRITICAL', outOfService: true },
    });
    expect(openCriticalDefect).not.toBeNull();
    const wo = await prisma.workOrder.findUnique({ where: { number: 'WO-2214' } });
    expect(wo?.vehicleId).toBe(unit110?.id);
  });

  it('has 58 drivers, including John Smith on unit #101 with CDL OH-W8569238', async () => {
    expect(await prisma.driver.count({ where: NOT_LEAKED_DRIVER })).toBe(58);
    const john = await prisma.driver.findFirst({
      where: { username: 'johnsmith', deletedAt: null },
      include: { assignedVehicle: true },
    });
    expect(john?.firstName).toBe('John');
    expect(john?.lastName).toBe('Smith');
    expect(john?.cdlNumber).toBe('OH-W8569238');
    expect(john?.cdlState).toBe('OH');
    expect(john?.homeTerminalName).toMatch(/Columbus/);
    expect(john?.homeTerminalTimezone).toBe('America/New_York');
    expect(john?.assignedVehicle?.unitNumber).toBe('101');
  });

  it('pairs John Smith with Marcus Webb on unit #101 (not William Bond, who drives #104)', async () => {
    const john = await prisma.driver.findFirst({ where: { username: 'johnsmith', deletedAt: null } });
    const marcus = await prisma.driver.findFirst({ where: { username: 'marcuswebb', deletedAt: null } });
    const william = await prisma.driver.findFirst({
      where: { username: 'williambond', deletedAt: null },
      include: { assignedVehicle: true },
    });
    expect(william?.assignedVehicle?.unitNumber).toBe('104');

    const pairing = await prisma.coDriverPairing.findFirst({
      where: { primaryDriverId: john?.id, coDriverId: marcus?.id },
      include: { vehicle: true },
    });
    expect(pairing?.vehicle.unitNumber).toBe('101');
  });

  it("John Smith's today log shows 11:26 driving with an 11-hour violation exceeded by 00:26", async () => {
    const john = await prisma.driver.findFirst({ where: { username: 'johnsmith', deletedAt: null } });
    const dailyLogs = await prisma.dailyLog.findMany({
      where: { driverId: john?.id },
      orderBy: { logDate: 'desc' },
    });
    expect(dailyLogs.length).toBe(8); // 8-day HOS log (tz.md §22.3.6)

    const today = dailyLogs[0];
    expect(today.drivingSec).toBe(11 * 3600 + 26 * 60);
    expect(today.hasViolation).toBe(true);

    const violation = await prisma.hosViolation.findFirst({
      where: { driverId: john?.id, logDate: today.logDate, type: 'DRIVING_11' },
    });
    expect(violation?.exceededBySec).toBe(26 * 60);
  });

  it('has DVIR #88214 (pre-trip, no defects) and #88208 (post-trip, defects repaired)', async () => {
    const dvir88214 = await prisma.dvir.findFirst({ where: { odometerMi: 88214 } });
    expect(dvir88214?.type).toBe('PRE_TRIP');
    expect(dvir88214?.vehicleCondition).toBe('SATISFACTORY');

    const dvir88208 = await prisma.dvir.findFirst({ where: { odometerMi: 88208 }, include: { defects: true } });
    expect(dvir88208?.type).toBe('POST_TRIP');
    expect(dvir88208?.vehicleCondition).toBe('DEFECTS_FOUND');
    expect(dvir88208?.repairStatus).toBe('REPAIRED');
    expect(dvir88208?.defects[0]?.status).toBe('REPAIRED');
  });

  it('has trip TR-4821 and at least one message + notification', async () => {
    const trip = await prisma.trip.findUnique({ where: { number: 'TR-4821' } });
    expect(trip).not.toBeNull();
    expect(await prisma.message.count()).toBeGreaterThan(0);
    expect(await prisma.notification.count()).toBeGreaterThan(0);
  });
});
