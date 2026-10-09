/**
 * §395 Appendix A (> tz.md §10.1) — the ELD Identifier / ELD Registration ID CHECK
 * constraints must stop an invalid value even if it arrives outside the DTO (seed,
 * script, direct SQL). Runs against the dev DB (tz.md §21 "Integration — dev DB").
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function ensureCarrier(): Promise<void> {
  await prisma.carrier.upsert({
    where: { id: 'carrier' },
    create: { id: 'carrier', name: 'Carrier', dotNumber: '' },
    update: {},
  });
}

describe('Carrier eRODS identifier constraints', () => {
  beforeAll(ensureCarrier);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('defaults erodsMode to TEST and eldIdentifier to a 6-char value (Appendix A 7.15, B-138)', async () => {
    const carrier = await prisma.carrier.findUniqueOrThrow({ where: { id: 'carrier' } });
    expect(carrier.eldIdentifier).toMatch(/^[A-Z0-9]{6}$/);
    expect(['TEST', 'PRODUCTION']).toContain(carrier.erodsMode);
  });

  it.each(['OBK1', 'OBK01', 'OBK0001', 'OB#001', 'ob,001'])(
    'rejects eldIdentifier %s at the DB level',
    async (value) => {
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "Carrier" SET "eldIdentifier" = $1 WHERE id = 'carrier'`,
          value,
        ),
      ).rejects.toThrow(/eld_identifier_format|value too long/i);
    },
  );

  it.each(['AB', 'ab12', 'A B1'])(
    'rejects eldRegistrationId %s at the DB level',
    async (value) => {
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "Carrier" SET "eldRegistrationId" = $1 WHERE id = 'carrier'`,
          value,
        ),
      ).rejects.toThrow(/eld_registration_id_format/i);
    },
  );

  it('still accepts a legal 6-char identifier + 4-char registration id and restores the TEST defaults', async () => {
    await prisma.carrier.update({
      where: { id: 'carrier' },
      data: { eldRegistrationId: 'AB12', eldIdentifier: '1001ZE' },
    });
    const updated = await prisma.carrier.findUniqueOrThrow({ where: { id: 'carrier' } });
    expect(updated.eldRegistrationId).toBe('AB12');
    expect(updated.eldIdentifier).toBe('1001ZE');

    await prisma.carrier.update({
      where: { id: 'carrier' },
      data: { eldRegistrationId: null, eldIdentifier: 'OBK001', erodsMode: 'TEST' },
    });
  });
});
