/**
 * `npm run qa:two-device-driver` — idempotent DEV-only test account for the mobile team's
 * two-phone / single-device takeover testing (D-164 note). Creates or converges:
 *
 *   - unit `201` (its own unit — never 106, never johnsmith's or the QA driver's),
 *   - a Virtual ELD paired to it (`Device.isVirtual`, serial `VPT30_TWODEV`, docs/virtual-eld.md, D-142..D-145),
 *   - driver `twodevice` / `Onebook2026` (seed demo password, real Argon2id hash), assigned to unit 201.
 *
 * Re-running changes nothing that is already right; it never touches other drivers, units or
 * devices, never resets the DB, and refuses production / the prod DB (same guard as
 * scripts/virtual-eld-purge.ts). DATABASE_URL: an exported value wins, else `.env.development`.
 */
import { PrismaClient } from '@prisma/client';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppConfigService } from '../src/core/config/config.service';
import { assertDatabaseTarget, PROD_DB_NAME } from '../src/core/config/db-guard';
import { parseEnv } from '../src/core/config/env.schema';
import { hashPassword, verifyPassword } from '../src/modules/auth/lib/password.util';
import { VIRTUAL_SERIAL_PATTERN } from '../src/modules/carrier/virtual-eld.policy';

const USERNAME = 'twodevice';
const PASSWORD = 'Onebook2026'; // prisma/seed.ts demo password
const UNIT_NUMBER = '201';
const DEVICE_SERIAL = 'VPT30_TWODEV';
const FORBIDDEN_UNITS = new Set(['106']);
const PROTECTED_USERNAMES = new Set(['johnsmith', 'devline.qa01']);

/** ISO 3779 check digit (position 9), so the VIN passes the app's own validation. */
function withCheckDigit(vin17: string): string {
  const map: Record<string, number> = {
    A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
    S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  };
  const weights = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = [...vin17].reduce((acc, ch, i) => acc + (/\d/.test(ch) ? Number(ch) : map[ch]) * weights[i], 0);
  const check = sum % 11 === 10 ? 'X' : String(sum % 11);
  return vin17.slice(0, 8) + check + vin17.slice(9);
}
const VIN = withCheckDigit('1FUJGLDR0TD201201');

function fail(message: string): never {
  console.error(`qa:two-device-driver: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const envFile = join(__dirname, '..', '.env.development');
  if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);

  const env = parseEnv();
  const config = new AppConfigService(env);
  if (config.isProduction) fail('refusing to run with NODE_ENV=production.');
  if (new URL(env.DATABASE_URL).pathname.slice(1) === PROD_DB_NAME) fail('DATABASE_URL points at the prod database.');
  assertDatabaseTarget(env);
  if (PROTECTED_USERNAMES.has(USERNAME) || FORBIDDEN_UNITS.has(UNIT_NUMBER)) fail('protected username/unit.');
  if (!VIRTUAL_SERIAL_PATTERN.test(DEVICE_SERIAL)) fail(`bad virtual serial ${DEVICE_SERIAL}.`);

  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  const changes: string[] = [];
  try {
    // Template = the QA driver (same carrier — the deployment is single-carrier — and home terminal).
    const qa = await prisma.driver.findFirst({ where: { username: 'devline.qa01', deletedAt: null } });
    const carrier = await prisma.carrier.findFirst();
    if (!carrier) fail('no Carrier row — seed the DB first.');
    if (!carrier.virtualEldEnabled) {
      console.warn('WARNING: Carrier.virtualEldEnabled is false — /ingest/* will answer 403 VIRTUAL_ELD_DISABLED for the virtual device. Not changed by this script.');
    }

    // --- unit -------------------------------------------------------------------------------
    let vehicle = await prisma.vehicle.findFirst({ where: { unitNumber: UNIT_NUMBER, deletedAt: null } });
    if (!vehicle) {
      vehicle = await prisma.vehicle.create({
        data: {
          unitNumber: UNIT_NUMBER,
          vin: VIN,
          make: 'Freightliner',
          model: 'Cascadia',
          year: 2023,
          licensePlate: 'TD201',
          plateState: qa?.cdlState ?? 'OH',
          status: 'ACTIVE',
          activatedAt: new Date(),
          odometerMi: 120_000,
          notes: 'Mobile two-device test unit (scripts/create-two-device-test-driver.ts).',
        },
      });
      changes.push(`created unit ${UNIT_NUMBER}`);
    }

    // The unit must belong to nobody but `twodevice`.
    const holder = await prisma.driver.findFirst({ where: { assignedVehicleId: vehicle.id } });
    if (holder && holder.username !== USERNAME) {
      fail(`unit ${UNIT_NUMBER} is assigned to "${holder.username}" — refusing to take it.`);
    }

    // --- virtual device ---------------------------------------------------------------------
    let device = await prisma.device.findUnique({ where: { serial: DEVICE_SERIAL } });
    const onUnit = await prisma.device.findFirst({ where: { vehicleId: vehicle.id } });
    if (onUnit && onUnit.serial !== DEVICE_SERIAL) {
      fail(`unit ${UNIT_NUMBER} already has device ${onUnit.serial} paired — refusing to displace it.`);
    }
    if (!device) {
      device = await prisma.device.create({
        data: {
          serial: DEVICE_SERIAL,
          model: 'PT30',
          firmware: 'V1.0.0',
          isVirtual: true,
          vehicleId: vehicle.id,
          status: 'ASSIGNED',
          pairedAt: new Date(),
        },
      });
      changes.push(`created virtual device ${DEVICE_SERIAL}`);
    } else if (device.vehicleId !== vehicle.id || !device.isVirtual || device.status !== 'ASSIGNED') {
      if (device.vehicleId && device.vehicleId !== vehicle.id) {
        fail(`${DEVICE_SERIAL} is paired with another unit (${device.vehicleId}) — refusing to move it.`);
      }
      device = await prisma.device.update({
        where: { id: device.id },
        data: { isVirtual: true, vehicleId: vehicle.id, status: 'ASSIGNED', pairedAt: device.pairedAt ?? new Date() },
      });
      changes.push(`re-paired ${DEVICE_SERIAL} to unit ${UNIT_NUMBER}`);
    }

    // --- driver -----------------------------------------------------------------------------
    let driver = await prisma.driver.findFirst({ where: { username: USERNAME, deletedAt: null } });
    if (!driver) {
      driver = await prisma.driver.create({
        data: {
          username: USERNAME,
          passwordHash: await hashPassword(PASSWORD),
          firstName: 'TwoDevice',
          lastName: 'Tester',
          cdlNumber: 'TD201201',
          cdlState: qa?.cdlState ?? 'OH',
          status: 'ACTIVE',
          homeTerminalName: qa?.homeTerminalName ?? 'Columbus, OH',
          homeTerminalTimezone: qa?.homeTerminalTimezone ?? 'America/New_York',
          hosRuleset: qa?.hosRuleset ?? 'US_70_8_PROPERTY',
          fleetManagerId: qa?.fleetManagerId ?? null,
          allowPersonalConveyance: qa?.allowPersonalConveyance ?? true,
          allowYardMove: qa?.allowYardMove ?? true,
          assignedVehicleId: vehicle.id,
        },
      });
      changes.push(`created driver ${USERNAME}`);
    } else {
      const data: { passwordHash?: string; status?: 'ACTIVE'; assignedVehicleId?: string } = {};
      if (!(await verifyPassword(driver.passwordHash, PASSWORD))) data.passwordHash = await hashPassword(PASSWORD);
      if (driver.status !== 'ACTIVE') data.status = 'ACTIVE';
      if (driver.assignedVehicleId !== vehicle.id) data.assignedVehicleId = vehicle.id;
      if (Object.keys(data).length > 0) {
        driver = await prisma.driver.update({ where: { id: driver.id }, data });
        changes.push(`updated driver ${USERNAME}: ${Object.keys(data).join(', ')}`);
      }
    }

    console.log(
      JSON.stringify(
        {
          changes: changes.length > 0 ? changes : ['nothing to do — already in place'],
          driver: { id: driver.id, username: USERNAME, password: PASSWORD },
          unit: { id: vehicle.id, unitNumber: vehicle.unitNumber, vin: vehicle.vin },
          device: { id: device.id, serial: device.serial, isVirtual: device.isVirtual, model: device.model },
          virtualEldEnabled: carrier.virtualEldEnabled,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
