import { NotificationChannelsService } from './notification-channels.service';

function buildService(stored: unknown = {}) {
  const carrier = {
    get: jest.fn(async () => ({ id: 'carrier', notificationChannels: stored })),
    ensure: jest.fn(async () => ({ id: 'carrier', notificationChannels: {} })),
    update: jest.fn(async (data: unknown) => ({ id: 'carrier', ...(data as object) })),
  };
  return { service: new NotificationChannelsService(carrier as never), carrier };
}

describe('NotificationChannelsService (TZ §20 B-87)', () => {
  it('defaults both channels to enabled when nothing is stored', async () => {
    const { service } = buildService(null);
    expect(await service.get()).toEqual({ email: { enabled: true }, webhook: { enabled: true } });
  });

  it('reflects a stored disabled channel', async () => {
    const { service } = buildService({ email: { enabled: false } });
    expect(await service.get()).toEqual({ email: { enabled: false }, webhook: { enabled: true } });
  });

  it('update() merges the patch over the current value and persists it', async () => {
    const { service, carrier } = buildService({ email: { enabled: true }, webhook: { enabled: true, url: 'https://x.example/hook' } });
    const result = await service.update({ webhook: { enabled: false, url: 'https://x.example/hook' } });
    expect(result).toEqual({ email: { enabled: true }, webhook: { enabled: false, url: 'https://x.example/hook' } });
    expect(carrier.update).toHaveBeenCalledWith({ notificationChannels: result });
  });
});
