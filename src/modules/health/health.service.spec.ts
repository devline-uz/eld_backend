let latestRedisInstance: { ping: jest.Mock } | undefined;

jest.mock('ioredis', () => ({
  Redis: jest.fn().mockImplementation(() => {
    latestRedisInstance = { ping: jest.fn().mockResolvedValue('PONG') };
    return latestRedisInstance;
  }),
}));

import { HealthRepository } from './health.repository';
import { HealthService } from './health.service';

describe('HealthService', () => {
  let repo: jest.Mocked<Pick<HealthRepository, 'pingDatabase'>>;
  let config: { get: jest.Mock };
  let storage: { ping: jest.Mock };
  let service: HealthService;

  beforeEach(() => {
    latestRedisInstance = undefined;
    repo = { pingDatabase: jest.fn() };
    config = { get: jest.fn((key: string) => (key === 'REDIS_URL' ? 'redis://localhost:6379' : 0)) };
    storage = { ping: jest.fn() };
    service = new HealthService(repo as unknown as HealthRepository, config as never, storage as never);
  });

  it('live() always returns ok without touching a dependency', () => {
    expect(service.live()).toEqual({ status: 'ok' });
    expect(repo.pingDatabase).not.toHaveBeenCalled();
  });

  describe('ready()', () => {
    it('reports up when the database responds', async () => {
      repo.pingDatabase.mockResolvedValue(true);
      const result = await service.ready();
      expect(result.status).toBe('up');
      expect(result.checks.database.status).toBe('up');
    });

    it('reports down with an error message when the database throws', async () => {
      repo.pingDatabase.mockRejectedValue(new Error('connection refused'));
      const result = await service.ready();
      expect(result.status).toBe('down');
      expect(result.checks.database.error).toBe('connection refused');
    });
  });

  describe('deep()', () => {
    it('reports up when database, redis and storage are all up, and lazily reuses the Redis client', async () => {
      repo.pingDatabase.mockResolvedValue(true);
      storage.ping.mockResolvedValue(undefined);

      const result = await service.deep();

      expect(result.status).toBe('up');
      expect(result.checks.database.status).toBe('up');
      expect(result.checks.storage.status).toBe('up');
      expect(result.checks.redis.status).toBe('up');
      expect(typeof result.uptimeSec).toBe('number');

      const firstInstance = latestRedisInstance;
      await service.deep();
      expect(latestRedisInstance).toBe(firstInstance); // client is memoized, not recreated
    });

    it('reports down when the database check fails', async () => {
      repo.pingDatabase.mockRejectedValue(new Error('db down'));
      storage.ping.mockResolvedValue(undefined);

      const result = await service.deep();

      expect(result.status).toBe('down');
      expect(result.checks.database.error).toBe('db down');
    });

    it('reports down when redis ping rejects', async () => {
      repo.pingDatabase.mockResolvedValue(true);
      storage.ping.mockResolvedValue(undefined);
      const { Redis } = jest.requireMock<{ Redis: jest.Mock }>('ioredis');
      Redis.mockImplementationOnce(() => ({ ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }));

      const result = await service.deep();

      expect(result.status).toBe('down');
      expect(result.checks.redis.error).toBe('ECONNREFUSED');
    });

    it('reports down when storage ping rejects', async () => {
      repo.pingDatabase.mockResolvedValue(true);
      storage.ping.mockRejectedValue(new Error('bucket unreachable'));

      const result = await service.deep();

      expect(result.status).toBe('down');
      expect(result.checks.storage.error).toBe('bucket unreachable');
    });
  });
});
