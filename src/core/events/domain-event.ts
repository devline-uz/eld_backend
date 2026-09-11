/** In-process domain event. Carries the traceId of the request that produced it. */
export interface DomainEvent<TPayload = unknown> {
  name: string;
  payload: TPayload;
  occurredAt: Date;
  traceId?: string;
}

export type DomainEventHandler<TPayload = unknown> = (
  event: DomainEvent<TPayload>,
) => void | Promise<void>;
