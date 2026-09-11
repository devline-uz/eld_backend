/**
 * tz.md §21 — integration coverage for the password-login repository path against the dev
 * DB seed (Sarah Chen = ADMIN with 2FA on, John Smith = driver, password `Onebook2026`
 * for both, hashed with the real Argon2id scheme by `prisma/seed.ts`).
 */
import { PrismaClient } from '@prisma/client';
import { verifyPassword } from '../../src/modules/auth/lib/password.util';

const prisma = new PrismaClient();

describe('seeded credentials are real Argon2id hashes (tz.md §6.5 / §22.3.6)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('Sarah Chen (ADMIN) has an Argon2id hash that verifies against "Onebook2026"', async () => {
    const sarah = await prisma.user.findUnique({
      where: { email: 'sarah.chen@universal-logistics.example' },
    });
    expect(sarah?.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(sarah!.passwordHash!, 'Onebook2026')).resolves.toBe(true);
    await expect(verifyPassword(sarah!.passwordHash!, 'wrong-password')).resolves.toBe(false);
  });

  it('Sarah Chen has 2FA enabled (ADMIN — TZ §6.2 mandatory 2FA)', async () => {
    const sarah = await prisma.user.findUnique({
      where: { email: 'sarah.chen@universal-logistics.example' },
      include: { role: true },
    });
    expect(sarah?.role.key).toBe('ADMIN');
    expect(sarah?.twoFactorEnabled).toBe(true);
  });

  it('a non-admin seeded user does not have 2FA enabled', async () => {
    const carlos = await prisma.user.findUnique({
      where: { email: 'carlos.ramirez@universal-logistics.example' },
      include: { role: true },
    });
    expect(carlos?.role.key).toBe('DISPATCHER');
    expect(carlos?.twoFactorEnabled).toBe(false);
  });

  it('John Smith (driver) has an Argon2id hash that verifies against "Onebook2026"', async () => {
    const john = await prisma.driver.findUnique({ where: { username: 'johnsmith' } });
    expect(john?.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(john!.passwordHash, 'Onebook2026')).resolves.toBe(true);
  });
});
