import { SessionRepository } from './session.repository';

const future = () => new Date(Date.now() + 60_000);

describe('SessionRepository', () => {
  describe('isLineageLive (CODE-012)', () => {
    function build(rows: Record<string, { userId: string; revokedAt: Date | null; expiresAt: Date; rotatedToId: string | null }>) {
      const findUnique = jest.fn(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null);
      return new SessionRepository({ session: { findUnique } } as never);
    }

    it('a live head session is live', async () => {
      const repo = build({ s1: { userId: 'u1', revokedAt: null, expiresAt: future(), rotatedToId: null } });
      await expect(repo.isLineageLive('s1', 'u1')).resolves.toBe(true);
    });

    it('a rotated session stays live while its successor is live (refresh does not sign out)', async () => {
      const repo = build({
        s1: { userId: 'u1', revokedAt: new Date(), expiresAt: future(), rotatedToId: 's2' },
        s2: { userId: 'u1', revokedAt: null, expiresAt: future(), rotatedToId: null },
      });
      await expect(repo.isLineageLive('s1', 'u1')).resolves.toBe(true);
    });

    it('revoking the head ends every token issued along the chain', async () => {
      const repo = build({
        s1: { userId: 'u1', revokedAt: new Date(), expiresAt: future(), rotatedToId: 's2' },
        s2: { userId: 'u1', revokedAt: new Date(), expiresAt: future(), rotatedToId: null },
      });
      await expect(repo.isLineageLive('s1', 'u1')).resolves.toBe(false);
    });

    it('refuses an expired head, a foreign session and an unknown id', async () => {
      const repo = build({
        s1: { userId: 'u1', revokedAt: null, expiresAt: new Date(Date.now() - 1), rotatedToId: null },
        s9: { userId: 'other', revokedAt: null, expiresAt: future(), rotatedToId: null },
      });
      await expect(repo.isLineageLive('s1', 'u1')).resolves.toBe(false);
      await expect(repo.isLineageLive('s9', 'u1')).resolves.toBe(false);
      await expect(repo.isLineageLive('nope', 'u1')).resolves.toBe(false);
    });

    it('gives up on an over-long chain', async () => {
      const rows: Record<string, { userId: string; revokedAt: Date | null; expiresAt: Date; rotatedToId: string | null }> = {};
      for (let i = 0; i < 20; i += 1) rows[`s${i}`] = { userId: 'u1', revokedAt: new Date(), expiresAt: future(), rotatedToId: `s${i + 1}` };
      rows.s20 = { userId: 'u1', revokedAt: null, expiresAt: future(), rotatedToId: null };
      await expect(build(rows).isLineageLive('s0', 'u1')).resolves.toBe(false);
    });
  });

  describe('rotate (CODE-019)', () => {
    function build(updatedCount: number) {
      const tx = {
        session: {
          create: jest.fn().mockResolvedValue({ id: 's2' }),
          updateMany: jest.fn().mockResolvedValue({ count: updatedCount }),
          delete: jest.fn().mockResolvedValue({}),
        },
      };
      const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
      return { repo: new SessionRepository(prisma as never), tx };
    }
    const input = { userId: 'u1', refreshHash: 'h2', expiresAt: future() };

    it('links the old row to the new one only if the old row is still unrevoked', async () => {
      const { repo, tx } = build(1);
      await expect(repo.rotate('s1', input)).resolves.toEqual({ id: 's2' });
      const [arg] = tx.session.updateMany.mock.calls[0] as unknown as [{ where: unknown; data: { revokedAt: unknown; rotatedToId: string } }];
      expect(arg.where).toEqual({ id: 's1', revokedAt: null });
      expect(arg.data.revokedAt).toBeInstanceOf(Date);
      expect(arg.data.rotatedToId).toBe('s2');
      expect(tx.session.delete).not.toHaveBeenCalled();
    });

    it('a lost race writes nothing and returns null', async () => {
      const { repo, tx } = build(0);
      await expect(repo.rotate('s1', input)).resolves.toBeNull();
      expect(tx.session.delete).toHaveBeenCalledWith({ where: { id: 's2' } });
    });
  });
});
