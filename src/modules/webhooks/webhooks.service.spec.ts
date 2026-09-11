import { AppException } from '../../common/errors/app.exception';
import { IntegrationsService } from '../integrations/integrations.service';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { WebhooksService } from './webhooks.service';

describe('WebhooksService', () => {
  let repo: jest.Mocked<Pick<WebhookDeliveryRepository, 'create'>>;
  let integrations: jest.Mocked<Pick<IntegrationsService, 'findEnabledByProvider'>>;
  let queue: { add: jest.Mock };
  let service: WebhooksService;

  beforeEach(() => {
    repo = { create: jest.fn() };
    integrations = { findEnabledByProvider: jest.fn() };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    service = new WebhooksService(
      repo as unknown as WebhookDeliveryRepository,
      integrations as unknown as IntegrationsService,
      queue as never,
    );
  });

  it('notify() is a no-op when no webhook integration is enabled', async () => {
    integrations.findEnabledByProvider.mockResolvedValue(null);

    const result = await service.notify('driver.created', { id: 'd_1' });

    expect(result).toBeNull();
    expect(repo.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('notify() is a no-op when the integration is enabled but has no url configured', async () => {
    integrations.findEnabledByProvider.mockResolvedValue({ id: 'int_1', config: {} } as never);

    const result = await service.notify('driver.created', { id: 'd_1' });

    expect(result).toBeNull();
  });

  it('notify() creates a WebhookDelivery row and enqueues exactly one job', async () => {
    integrations.findEnabledByProvider.mockResolvedValue({
      id: 'int_1',
      config: { url: 'https://example.com/hook', secret: 'v1:iv:tag:ct' },
    } as never);
    repo.create.mockResolvedValue({ id: 'whd_1' } as never);

    const result = await service.notify('driver.created', { id: 'd_1' });

    expect(result).toEqual({ id: 'whd_1' });
    expect(repo.create).toHaveBeenCalledWith({
      integrationId: 'int_1',
      url: 'https://example.com/hook',
      eventType: 'driver.created',
      payload: { id: 'd_1' },
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'deliver',
      { deliveryId: 'whd_1' },
      { attempts: 1, removeOnComplete: true, removeOnFail: true },
    );
  });

  it('sendTest() throws INTEGRATION_NOT_CONFIGURED instead of silently no-op-ing', async () => {
    integrations.findEnabledByProvider.mockResolvedValue(null);
    await expect(service.sendTest('test.ping', {})).rejects.toThrow(AppException);
  });
});
