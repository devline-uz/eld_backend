import { EventEmitter } from 'node:events';
import { AppConfigService } from '../config/config.service';
import { EventBusService } from './event-bus.service';
import { RealtimePubSubService } from './realtime-pubsub.service';

class FakeRedis extends EventEmitter {
  publish = jest.fn(async () => 1);
  subscribe = jest.fn(async () => undefined);
  quit = jest.fn(async () => 'OK');
}

const instances: FakeRedis[] = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const instance = new FakeRedis();
    instances.push(instance);
    return instance;
  }),
}));

/**
 * B-49 — `RealtimePubSubService` is the only thing bridging `realtime.push` across the
 * API/worker process boundary (see class doc). This asserts both directions of the bridge
 * with a fake `ioredis` client: a local `EventBusService.publish('realtime.push', ...)` ends
 * up on the Redis "publisher", and a message arriving on the Redis "subscriber" reaches
 * `onRelayed` listeners — the path `RealtimeGateway` depends on.
 */
describe('RealtimePubSubService', () => {
  beforeEach(() => {
    instances.length = 0;
  });

  function makeService(): { service: RealtimePubSubService; events: EventBusService } {
    const values: Record<string, unknown> = { REDIS_URL: 'redis://localhost:6379', REDIS_DB: 3, QUEUE_PREFIX: 'onebook' };
    const config = { get: (key: string) => values[key] } as AppConfigService;
    const events = new EventBusService();
    const service = new RealtimePubSubService(config, events);
    return { service, events };
  }

  it('forwards a locally published realtime.push event onto the Redis publisher', async () => {
    const { service, events } = makeService();
    service.onModuleInit();

    await events.publish('realtime.push', { room: 'user:123', event: 'report.ready', payload: { reportId: 'r1' } });

    const [publisher] = instances;
    expect(publisher.publish).toHaveBeenCalledWith(
      'onebook:db3:realtime:push',
      JSON.stringify({ room: 'user:123', event: 'report.ready', payload: { reportId: 'r1' } }),
    );

    await service.onModuleDestroy();
  });

  it('delivers a message received on the Redis subscriber to onRelayed listeners', async () => {
    const { service } = makeService();
    service.onModuleInit();

    const [, subscriber] = instances;
    const received: unknown[] = [];
    service.onRelayed((payload) => received.push(payload));

    subscriber.emit('message', 'onebook:db3:realtime:push', JSON.stringify({ room: 'user:9', event: 'report.ready', payload: { ok: true } }));

    expect(received).toEqual([{ room: 'user:9', event: 'report.ready', payload: { ok: true } }]);

    await service.onModuleDestroy();
  });

  it('B-097 — namespaces the channel by QUEUE_PREFIX + REDIS_DB (pub/sub ignores the DB number)', () => {
    const { service } = makeService();
    service.onModuleInit();
    const [, subscriber] = instances;
    expect(subscriber.subscribe).toHaveBeenCalledWith('onebook:db3:realtime:push');
    void service.onModuleDestroy();
  });

  it('B-097 — drops messages from another channel and malformed / out-of-grammar payloads', async () => {
    const { service } = makeService();
    service.onModuleInit();
    const [, subscriber] = instances;
    const received: unknown[] = [];
    service.onRelayed((payload) => received.push(payload));

    subscriber.emit('message', 'realtime:push', JSON.stringify({ room: 'fleet', event: 'x', payload: {} }));
    subscriber.emit('message', 'onebook:db3:realtime:push', 'not json');
    subscriber.emit('message', 'onebook:db3:realtime:push', JSON.stringify({ room: 'user:1 /other-namespace', event: 'x' }));
    subscriber.emit('message', 'onebook:db3:realtime:push', JSON.stringify({ room: 'fleet', event: { toString: 1 } }));
    subscriber.emit('message', 'onebook:db3:realtime:push', JSON.stringify(['fleet']));

    expect(received).toEqual([]);
    await service.onModuleDestroy();
  });

  it('cleans up local subscription and disconnects both Redis clients on destroy', async () => {
    const { service } = makeService();
    service.onModuleInit();
    const [publisher, subscriber] = instances;

    await service.onModuleDestroy();

    expect(publisher.quit).toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });
});
