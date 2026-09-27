/** §10.3 UNRESOLVED_UNIDENTIFIED — which unidentified segments count as unresolved before a send. */
import type { PrismaService } from '../../core/prisma/prisma.service';
import { TransfersRepository } from './transfers.repository';

describe('TransfersRepository.findPendingUnidentifiedSegments', () => {
  it('B-83: counts PENDING_CONFIRMATION as unresolved — its records are still unidentified', async () => {
    const findMany = jest.fn(async () => []);
    const repo = new TransfersRepository({ unidentifiedSegment: { findMany } } as unknown as PrismaService);
    const from = new Date('2026-06-01T00:00:00Z');
    const to = new Date('2026-06-08T00:00:00Z');

    await repo.findPendingUnidentifiedSegments(from, to);

    expect(findMany).toHaveBeenCalledWith({
      where: { status: { in: ['PENDING', 'PENDING_CONFIRMATION'] }, startAt: { lte: to }, endAt: { gte: from } },
    });
  });
});
