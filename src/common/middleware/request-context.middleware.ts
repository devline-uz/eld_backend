import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { RequestContext, RequestContextData } from '../../core/context/request-context';

export const TRACE_HEADER = 'x-trace-id';
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Opens the AsyncLocalStorage scope for every request (TZ §27.1 point 3) and echoes
 * the traceId back so clients and the §20 error envelope agree on one id.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const traceId = headerValue(req, TRACE_HEADER) ?? randomUUID();
    const requestId = headerValue(req, REQUEST_ID_HEADER) ?? randomUUID();

    const ctx: RequestContextData = {
      requestId,
      traceId,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
      startedAt: Date.now(),
    };

    res.setHeader(TRACE_HEADER, traceId);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    RequestContext.run(ctx, () => next());
  }
}

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.length > 0 ? value : undefined;
}
