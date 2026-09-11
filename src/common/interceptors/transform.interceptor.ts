import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { RequestContext } from '../../core/context/request-context';

/**
 * Success-response envelope. Mirrors the §20 error envelope so clients always find
 * `traceId` in the same place. Handlers that already return a shaped payload
 * (`{ items, nextCursor }`) keep it under `data`.
 */
export interface ResponseEnvelope<T> {
  data: T;
  traceId: string;
  timestamp: string;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ResponseEnvelope<T> | T> {
  intercept(_ctx: ExecutionContext, next: CallHandler<T>): Observable<ResponseEnvelope<T> | T> {
    return next.handle().pipe(
      map((data) => {
        // Streamed/raw payloads (files, /metrics) opt out by returning a Buffer or string.
        if (data instanceof Buffer || typeof data === 'string') return data;
        return {
          data,
          traceId: RequestContext.traceId ?? '',
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
