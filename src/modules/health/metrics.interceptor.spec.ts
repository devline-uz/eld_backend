import { of, throwError } from 'rxjs';
import { MetricsInterceptor } from './metrics.interceptor';

interface FakeRequest {
  method: string;
  route?: { path: string };
}

function makeContext(type: string, route?: string, statusCode = 200) {
  const req: FakeRequest = { method: 'GET' };
  if (route) req.route = { path: route };
  const res = { statusCode };
  return {
    getType: (): string => type,
    switchToHttp: () => ({
      getRequest: (): FakeRequest => req,
      getResponse: (): { statusCode: number } => res,
    }),
  };
}

describe('MetricsInterceptor', () => {
  it('passes through non-HTTP contexts without recording', (done) => {
    const metrics = { httpDuration: { startTimer: jest.fn() }, httpRequests: { inc: jest.fn() } };
    const interceptor = new MetricsInterceptor(metrics as never);
    const ctx = makeContext('rpc') as never;
    interceptor.intercept(ctx, { handle: () => of('ok') } as never).subscribe(() => {
      expect(metrics.httpDuration.startTimer).not.toHaveBeenCalled();
      done();
    });
  });

  it('records duration + count on a successful HTTP response', (done) => {
    const stop = jest.fn();
    const metrics = { httpDuration: { startTimer: jest.fn().mockReturnValue(stop) }, httpRequests: { inc: jest.fn() } };
    const interceptor = new MetricsInterceptor(metrics as never);
    const ctx = makeContext('http', '/api/vehicles/:id', 200) as never;
    interceptor.intercept(ctx, { handle: () => of({ ok: true }) } as never).subscribe(() => {
      expect(stop).toHaveBeenCalledWith({ method: 'GET', route: '/api/vehicles/:id', status: '200' });
      expect(metrics.httpRequests.inc).toHaveBeenCalledWith({ method: 'GET', route: '/api/vehicles/:id', status: '200' });
      done();
    });
  });

  it('falls back to "unknown" route and still records on error', (done) => {
    const stop = jest.fn();
    const metrics = { httpDuration: { startTimer: jest.fn().mockReturnValue(stop) }, httpRequests: { inc: jest.fn() } };
    const interceptor = new MetricsInterceptor(metrics as never);
    const ctx = makeContext('http', undefined, 500) as never;
    interceptor.intercept(ctx, { handle: () => throwError(() => new Error('boom')) } as never).subscribe({
      error: () => {
        expect(stop).toHaveBeenCalledWith({ method: 'GET', route: 'unknown', status: '500' });
        done();
      },
    });
  });
});
