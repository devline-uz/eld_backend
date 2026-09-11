import { RequestContext, RequestContextData } from './request-context';

function makeCtx(overrides: Partial<RequestContextData> = {}): RequestContextData {
  return { requestId: 'req_1', traceId: 'trace_1', startedAt: Date.now(), ...overrides };
}

describe('RequestContext', () => {
  it('get() returns undefined outside a bound run()', () => {
    expect(RequestContext.get()).toBeUndefined();
    expect(RequestContext.traceId).toBeUndefined();
    expect(RequestContext.user).toBeUndefined();
    expect(RequestContext.carrierId).toBeUndefined();
  });

  it('require() throws outside a bound run()', () => {
    expect(() => RequestContext.require()).toThrow(/not available/);
  });

  it('run() binds the context for the duration of fn, and getters read from it', () => {
    RequestContext.run(makeCtx({ carrierId: 'carrier', user: { id: 'u1', type: 'user' } }), () => {
      expect(RequestContext.get()).toMatchObject({ requestId: 'req_1' });
      expect(RequestContext.traceId).toBe('trace_1');
      expect(RequestContext.carrierId).toBe('carrier');
      expect(RequestContext.user).toEqual({ id: 'u1', type: 'user' });
      expect(RequestContext.require().requestId).toBe('req_1');
    });
  });

  it('set() mutates the ambient context in place', () => {
    RequestContext.run(makeCtx(), () => {
      RequestContext.set('carrierId', 'new-carrier');
      expect(RequestContext.carrierId).toBe('new-carrier');
    });
  });

  it('set() is a no-op outside a bound run()', () => {
    expect(() => RequestContext.set('carrierId', 'x')).not.toThrow();
  });

  it('propagates context through async work inside run()', async () => {
    await RequestContext.run(makeCtx({ traceId: 'async-trace' }), async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(RequestContext.traceId).toBe('async-trace');
    });
  });
});
