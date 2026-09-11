import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

/** Records request count and duration for the p95 target in TZ §19. */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    const stop = this.metrics.httpDuration.startTimer();

    const record = (): void => {
      const labels = {
        method: req.method,
        route: routePath(req) ?? 'unknown',
        status: String(http.getResponse<Response>().statusCode),
      };
      stop(labels);
      this.metrics.httpRequests.inc(labels);
    };

    return next.handle().pipe(tap({ next: record, error: record }));
  }
}

/** Express fills `req.route` only after routing; the type is untyped in @types/express. */
function routePath(req: Request): string | undefined {
  const route = (req as unknown as { route?: { path?: string } }).route;
  return route?.path;
}
