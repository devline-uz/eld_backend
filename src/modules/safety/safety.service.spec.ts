import { AppException } from '../../common/errors/app.exception';
import { SafetyRepository } from './safety.repository';
import { SafetyService } from './safety.service';

describe('SafetyService (B-43 driver-level coaching, B-44 scorecard trend)', () => {
  let repo: jest.Mocked<Pick<SafetyRepository, 'findById' | 'update' | 'findLatestOpenForDriver' | 'scorecard'>>;
  let service: SafetyService;

  beforeEach(() => {
    repo = { findById: jest.fn(), update: jest.fn(), findLatestOpenForDriver: jest.fn(), scorecard: jest.fn() };
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

  describe('scorecard', () => {
    it('B-44 — attaches previousScore/trend from the immediately preceding period of the same length', async () => {
      const periodStart = new Date('2026-09-01T00:00:00.000Z');
      const periodEnd = new Date('2026-09-08T00:00:00.000Z'); // 7-day period
      repo.scorecard.mockImplementation((start) => {
        if (start.getTime() === periodStart.getTime()) {
          return Promise.resolve([{ driverId: 'drv_1', score: 68, harshCount: 4, rank: 1 }] as never);
        }
        return Promise.resolve([{ driverId: 'drv_1', score: 80, harshCount: 1, rank: 1 }] as never);
      });

      const result = await service.scorecard({ periodStart, periodEnd });

      expect(result.items).toEqual([expect.objectContaining({ driverId: 'drv_1', score: 68, previousScore: 80, trend: -12 })]);
      // Previous period is the same 7-day length, ending the day before periodStart.
      const [, previousCall] = repo.scorecard.mock.calls;
      expect(previousCall[1]).toEqual(new Date(periodStart.getTime() - 24 * 60 * 60 * 1000));
    });

    it('B-44 — previousScore/trend are null with no prior scored period', async () => {
      repo.scorecard.mockResolvedValueOnce([{ driverId: 'drv_1', score: 68 }] as never).mockResolvedValueOnce([] as never);

      const result = await service.scorecard({ periodStart: new Date('2026-09-01T00:00:00.000Z'), periodEnd: new Date('2026-09-08T00:00:00.000Z') });

      expect(result.items).toEqual([expect.objectContaining({ previousScore: null, trend: null })]);
    });
  });
});
