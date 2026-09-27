/**
 * tz.md §21 — integration coverage for the password-login repository path against the dev
 * DB seed (Sarah Chen = ADMIN, John Smith = driver, password `Onebook2026` for both, hashed
 * with the real Argon2id scheme by `prisma/seed.ts`).
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

  it('John Smith (driver) has an Argon2id hash that verifies against "Onebook2026"', async () => {
    const john = await prisma.driver.findFirst({ where: { username: 'johnsmith', deletedAt: null } });
    expect(john?.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(john!.passwordHash, 'Onebook2026')).resolves.toBe(true);
  });
});
