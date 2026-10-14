import { DashboardRepository } from './dashboard.repository';

describe('DashboardRepository.pendingUnidentified', () => {
  it('splits unassigned (PENDING) from awaiting-driver (PENDING_CONFIRMATION) segments', async () => {
    const groupBy = jest.fn().mockResolvedValue([
      { status: 'PENDING', _count: { _all: 40 }, _sum: { durationSec: 24000 } },
      { status: 'PENDING_CONFIRMATION', _count: { _all: 2 }, _sum: { durationSec: 1200 } },
    ]);
    const repo = new DashboardRepository({ unidentifiedSegment: { groupBy } } as never);
    await expect(repo.pendingUnidentified()).resolves.toEqual({
      total: 40,
      totalDurationSec: 24000,
      awaitingDriver: 2,
      awaitingDriverDurationSec: 1200,
    });
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ['PENDING', 'PENDING_CONFIRMATION'] } } }),
    );
  });

  it('reads zeros when there is nothing pending', async () => {
    const repo = new DashboardRepository({ unidentifiedSegment: { groupBy: jest.fn().mockResolvedValue([]) } } as never);
    await expect(repo.pendingUnidentified()).resolves.toEqual({
      total: 0,
      totalDurationSec: 0,
      awaitingDriver: 0,
      awaitingDriverDurationSec: 0,
    });
  });
});
