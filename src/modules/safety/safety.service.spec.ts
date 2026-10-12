import { AppException } from '../../common/errors/app.exception';
import { SafetyRepository } from './safety.repository';
import { SafetyService } from './safety.service';

describe('SafetyService (B-43 driver-level coaching, B-44/D-141 scorecard)', () => {
  let repo: jest.Mocked<Pick<SafetyRepository, 'findById' | 'update' | 'findLatestOpenForDriver' | 'scorecard' | 'latestPeriod'>>;
  let service: SafetyService;

  beforeEach(() => {
    repo = { findById: jest.fn(), update: jest.fn(), findLatestOpenForDriver: jest.fn(), scorecard: jest.fn(), latestPeriod: jest.fn() };
    service = new SafetyService(repo as unknown as SafetyRepository);
  });

  describe('coach', () => {
    it('coaches the given eventId directly', async () => {
      repo.findById.mockResolvedValue({ id: 'sfe_1' } as never);
      repo.update.mockResolvedValue({ id: 'sfe_1', status: 'COACHED' } as never);

      await service.coach({ eventId: 'sfe_1', note: 'Slow down' }, 'usr_1');

      expect(repo.findById).toHaveBeenCalledWith({ id: 'sfe_1' });
      expect(repo.update).toHaveBeenCalledWith({ id: 'sfe_1' }, expect.objectContaining({ status: 'COACHED', coachedById: 'usr_1' }));
    });

    it('B-43 — driverId resolves to that driver\'s most recent open event', async () => {
      repo.findLatestOpenForDriver.mockResolvedValue({ id: 'sfe_2' } as never);
      repo.findById.mockResolvedValue({ id: 'sfe_2' } as never);
      repo.update.mockResolvedValue({ id: 'sfe_2', status: 'COACHED' } as never);

      await service.coach({ driverId: 'drv_1' }, 'usr_1');

      expect(repo.findLatestOpenForDriver).toHaveBeenCalledWith('drv_1');
      expect(repo.update).toHaveBeenCalledWith({ id: 'sfe_2' }, expect.objectContaining({ status: 'COACHED' }));
    });

    it('404s when driverId has no open event to coach', async () => {
      repo.findLatestOpenForDriver.mockResolvedValue(null);
      await expect(service.coach({ driverId: 'drv_1' }, 'usr_1')).rejects.toBeInstanceOf(AppException);
      expect(repo.findById).not.toHaveBeenCalled();
    });
  });

  describe('scorecard (D-141)', () => {
    const row = (over: Record<string, unknown>) => ({
      id: `dsc_${String(over.driverId)}`,
      periodStart: new Date('2026-09-11T00:00:00.000Z'),
      periodEnd: new Date('2026-10-10T00:00:00.000Z'),
      score: 0,
      scored: true,
      harshCount: 0,
      speedingCount: 0,
      seatbeltCount: 0,
      milesDriven: 0,
      violationCount: 0,
      rank: null,
      computedAt: new Date('2026-10-11T10:30:00.000Z'),
      ...over,
    });
    const prevRow = (over: Record<string, unknown>) =>
      row({ periodStart: new Date('2026-08-12T00:00:00.000Z'), periodEnd: new Date('2026-09-10T00:00:00.000Z'), ...over });

    function mockPeriods(current: unknown[], previous: unknown[]) {
      repo.scorecard.mockImplementation((start: Date) =>
        Promise.resolve((start.toISOString().startsWith('2026-09-11') ? current : start.toISOString().startsWith('2026-08-12') ? previous : []) as never),
      );
    }

    it('with no query returns the latest computed period (max periodEnd)', async () => {
      repo.latestPeriod.mockResolvedValue({ periodStart: new Date('2026-09-11T00:00:00.000Z'), periodEnd: new Date('2026-10-10T00:00:00.000Z') });
      mockPeriods([row({ driverId: 'drv_1', score: 90, milesDriven: 1000, rank: 1 })], []);

      const result = await service.scorecard({});

      expect(result.periodStart).toBe('2026-09-11');
      expect(result.periodEnd).toBe('2026-10-10');
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual(expect.objectContaining({ periodStart: '2026-09-11', periodEnd: '2026-10-10', computedAt: '2026-10-11T10:30:00.000Z' }));
      // Baseline = same-length period ending the day before.
      expect(repo.scorecard.mock.calls.map(([d]) => d.toISOString().slice(0, 10))).toEqual(['2026-09-11', '2026-08-12']);
    });

    it('returns an empty, null-period response when nothing has been computed yet', async () => {
      repo.latestPeriod.mockResolvedValue(null);
      const result = await service.scorecard({});
      expect(result).toEqual(expect.objectContaining({ periodStart: null, periodEnd: null, items: [], minMiles: 100 }));
      expect(result.fleet.score).toBeNull();
    });

    it('unscored rows return score/rank null and sort after ranked rows; fleet is mile-weighted with trend', async () => {
      repo.latestPeriod.mockResolvedValue({ periodStart: new Date('2026-09-11T00:00:00.000Z'), periodEnd: new Date('2026-10-10T00:00:00.000Z') });
      mockPeriods(
        [
          row({ driverId: 'drv_low', score: 0, scored: false, milesDriven: 40, rank: null }),
          row({ driverId: 'drv_b', score: 60, milesDriven: 1000, rank: 2 }),
          row({ driverId: 'drv_a', score: 100, milesDriven: 3000, rank: 1 }),
        ],
        [prevRow({ driverId: 'drv_a', score: 80, milesDriven: 1000 }), prevRow({ driverId: 'drv_b', score: 70, milesDriven: 1000 }), prevRow({ driverId: 'drv_low', score: 0, scored: false, milesDriven: 10 })],
      );

      const result = await service.scorecard({});

      expect(result.items.map((i) => [i.driverId, i.rank, i.score])).toEqual([
        ['drv_a', 1, 100],
        ['drv_b', 2, 60],
        ['drv_low', null, null],
      ]);
      expect(result.items[0]).toEqual(expect.objectContaining({ previousScore: 80, trend: 20 }));
      expect(result.items[2]).toEqual(expect.objectContaining({ previousScore: null, trend: null }));
      // (100×3000 + 60×1000) / 4000 = 90 ; previous (80+70)/2 = 75
      expect(result.fleet).toEqual({ score: 90, previousScore: 75, trend: 15, scoredDrivers: 2, unscoredDrivers: 1, belowThresholdCount: 1, milesDriven: 4000 });
    });

    it('an explicit periodStart selects that stored period', async () => {
      mockPeriods([row({ driverId: 'drv_1', score: 95, milesDriven: 500, rank: 1 })], []);
      const result = await service.scorecard({ periodStart: '2026-09-11' });
      expect(repo.latestPeriod).not.toHaveBeenCalled();
      expect(result.periodEnd).toBe('2026-10-10');
      expect(result.fleet.score).toBe(95);
    });
  });
});
