import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { firstValueFrom, of } from 'rxjs';
import { RequestContext } from '../../core/context/request-context';
import { TransformInterceptor } from './transform.interceptor';

describe('TransformInterceptor', () => {
  const ctx = {} as ExecutionContext;
  const next = (result: unknown): CallHandler<unknown> => ({ handle: () => of(result) });
  const interceptor = new TransformInterceptor<unknown>();

  function withRequestContext<T>(fn: () => Promise<T>): Promise<T> {
    return RequestContext.run(
      { requestId: 'r1', traceId: 'trace_1', startedAt: Date.now(), user: undefined },
      fn,
    );
  }

  it('wraps a plain object response in the { data, traceId, timestamp } envelope', async () => {
    const result = await withRequestContext(() => firstValueFrom(interceptor.intercept(ctx, next({ ok: true }))));
    expect(result).toEqual({ data: { ok: true }, traceId: 'trace_1', timestamp: expect.any(String) as string });
  });

  it('passes a Buffer response through unwrapped', async () => {
    const buf = Buffer.from('pdf-bytes');
    const result = await withRequestContext(() => firstValueFrom(interceptor.intercept(ctx, next(buf))));
    expect(result).toBe(buf);
  });

  it('passes a string response through unwrapped', async () => {
    const result = await withRequestContext(() => firstValueFrom(interceptor.intercept(ctx, next('csv,row'))));
    expect(result).toBe('csv,row');
  });

  // B-111 — the same interceptor is where every Decimal leak (raw Prisma rows returned by a
  // handler) gets caught, app-wide, without each handler having to remember to convert it.
  it('converts a Prisma Decimal field anywhere in the response to a number', async () => {
    const result = await withRequestContext(() =>
      firstValueFrom(
        interceptor.intercept(
          ctx,
          next({ items: [{ centerLat: new Prisma.Decimal('38.897639'), centerLon: new Prisma.Decimal('-77.036553') }] }),
        ),
      ),
    );
    const data = (result as { data: { items: [{ centerLat: unknown; centerLon: unknown }] } }).data;
    expect(data.items[0].centerLat).toBe(38.897639);
    expect(data.items[0].centerLon).toBe(-77.036553);
    expect(typeof data.items[0].centerLat).toBe('number');
  });
});
