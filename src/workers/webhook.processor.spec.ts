import { IntegrationsService } from '../modules/integrations/integrations.service';
import { WebhookDeliveryRepository } from '../modules/webhooks/webhook-delivery.repository';
import { WebhookProcessor } from './webhook.processor';

function makeDelivery(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'whd_1',
    integrationId: 'int_1',
    url: 'https://example.com/hook',
    eventType: 'driver.created',
    payload: { id: 'd_1' },
    signature: '',
    status: 'QUEUED',
    attempts: 0,
    httpStatus: null,
    responseBody: null,
    nextRetryAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('WebhookProcessor', () => {
  let deliveries: jest.Mocked<Pick<WebhookDeliveryRepository, 'findById' | 'recordAttempt'>>;
  let integrations: jest.Mocked<Pick<IntegrationsService, 'getDecryptedSecret'>>;
  let queue: { add: jest.Mock };
  let processor: WebhookProcessor;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    deliveries = { findById: jest.fn(), recordAttempt: jest.fn() };
    integrations = { getDecryptedSecret: jest.fn().mockResolvedValue('whsec_abc') };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    processor = new WebhookProcessor(
      deliveries as unknown as WebhookDeliveryRepository,
      integrations as unknown as IntegrationsService,
      queue as never,
    );
    fetchMock = jest.fn();
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as never;
  });

  it('marks the delivery SENT on a 2xx response and does not requeue', async () => {
    fetchMock.mockResolvedValue({ status: 200, text: () => Promise.resolve('ok') });
    deliveries.findById.mockResolvedValue(makeDelivery() as never);

    await processor.process({ data: { deliveryId: 'whd_1' } } as never);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-OneBook-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(deliveries.recordAttempt).toHaveBeenCalledWith(
      'whd_1',
      expect.objectContaining({ status: 'SENT', attempts: 1, httpStatus: 200, nextRetryAt: null }),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('schedules a retry at the 1s/10s/60s cadence on failure, until attempt 3', async () => {
    fetchMock.mockResolvedValue({ status: 500, text: () => Promise.resolve('server error') });
    deliveries.findById.mockResolvedValue(makeDelivery({ attempts: 0 }) as never);

    await processor.process({ data: { deliveryId: 'whd_1' } } as never);

    expect(deliveries.recordAttempt).toHaveBeenCalledWith(
      'whd_1',
      expect.objectContaining({ status: 'QUEUED', attempts: 1, httpStatus: 500 }),
    );
    expect(queue.add).toHaveBeenCalledWith('deliver', { deliveryId: 'whd_1' }, expect.objectContaining({ delay: 1000 }));
  });

  it('uses the 10s delay on the second retry', async () => {
    fetchMock.mockResolvedValue({ status: 500, text: () => Promise.resolve('server error') });
    deliveries.findById.mockResolvedValue(makeDelivery({ attempts: 1 }) as never);

    await processor.process({ data: { deliveryId: 'whd_1' } } as never);

    expect(queue.add).toHaveBeenCalledWith('deliver', { deliveryId: 'whd_1' }, expect.objectContaining({ delay: 10_000 }));
  });

  it('marks FAILED (no further requeue) after the third failed attempt', async () => {
    fetchMock.mockResolvedValue({ status: 500, text: () => Promise.resolve('server error') });
    deliveries.findById.mockResolvedValue(makeDelivery({ attempts: 2 }) as never);

    await processor.process({ data: { deliveryId: 'whd_1' } } as never);

    expect(deliveries.recordAttempt).toHaveBeenCalledWith(
      'whd_1',
      expect.objectContaining({ status: 'FAILED', attempts: 3, nextRetryAt: null }),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('treats a network error (fetch throws) the same as a failed HTTP response', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    deliveries.findById.mockResolvedValue(makeDelivery({ attempts: 0 }) as never);

    await processor.process({ data: { deliveryId: 'whd_1' } } as never);

    expect(deliveries.recordAttempt).toHaveBeenCalledWith(
      'whd_1',
      expect.objectContaining({ status: 'QUEUED', attempts: 1 }),
    );
    const call = deliveries.recordAttempt.mock.calls[0][1] as { responseBody: string };
    expect(call.responseBody).toContain('ECONNREFUSED');
  });

  it('skips silently if the WebhookDelivery row is missing (e.g. purged)', async () => {
    deliveries.findById.mockResolvedValue(null);

    await processor.process({ data: { deliveryId: 'gone' } } as never);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(deliveries.recordAttempt).not.toHaveBeenCalled();
  });
});
