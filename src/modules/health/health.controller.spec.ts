import { HealthController } from './health.controller';

describe('HealthController — delegates to HealthService/MetricsService', () => {
  const health = {
    live: jest.fn().mockReturnValue({ status: 'ok' }),
    ready: jest.fn().mockResolvedValue({ status: 'up', checks: {} }),
    deep: jest.fn().mockResolvedValue({ status: 'up', uptimeSec: 1, checks: {} }),
  };
  const metrics = {
    contentType: 'text/plain',
    scrape: jest.fn().mockResolvedValue('# metrics'),
  };
  const controller = new HealthController(health as never, metrics as never);

  it('live', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('ready', async () => {
    await controller.ready();
    expect(health.ready).toHaveBeenCalled();
  });

  it('deep', async () => {
    await controller.deep();
    expect(health.deep).toHaveBeenCalled();
  });

  it('scrape sets the Prometheus content type and returns the registry text', async () => {
    const res = { setHeader: jest.fn() };
    const result = await controller.scrape(res as never);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain');
    expect(result).toBe('# metrics');
  });
});
