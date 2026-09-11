import { Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '../context/request-context';
import { DomainEvent, DomainEventHandler } from './domain-event';

/**
 * In-process domain event bus (TZ §3.4 `core/events`).
 * Deliberately not a message broker: cross-container work goes through BullMQ.
 * Handler failures are logged, never propagated to the publisher.
 */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);
  private readonly handlers = new Map<string, Set<DomainEventHandler>>();

  on<TPayload>(name: string, handler: DomainEventHandler<TPayload>): () => void {
    const set = this.handlers.get(name) ?? new Set<DomainEventHandler>();
    set.add(handler as DomainEventHandler);
    this.handlers.set(name, set);
    return () => set.delete(handler as DomainEventHandler);
  }

  async publish<TPayload>(name: string, payload: TPayload): Promise<void> {
    const event: DomainEvent<TPayload> = {
      name,
      payload,
      occurredAt: new Date(),
      traceId: RequestContext.traceId,
    };
    const set = this.handlers.get(name);
    if (!set?.size) return;
    await Promise.all(
      [...set].map(async (handler) => {
        try {
          await handler(event);
        } catch (err) {
          this.logger.error(
            { event: name, traceId: event.traceId, err },
            `Domain event handler failed for "${name}"`,
          );
        }
      }),
    );
  }
}
