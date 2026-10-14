import type { ExecutionContext } from '@nestjs/common';
import { InternalProbeGuard } from './internal-probe.guard';

function ctx(ip: string, authorization?: string): ExecutionContext {
  const req = { ip, headers: authorization ? { authorization } : {}, socket: { remoteAddress: ip } };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('InternalProbeGuard (CODE-082 — /metrics, /health/deep)', () => {
  const TOKEN = 'metrics-token-metrics-token-123';
  const guard = (token?: string) => new InternalProbeGuard({ get: jest.fn(() => token) } as never);

  it.each(['127.0.0.1', '::1', '10.4.0.7', '172.18.0.3', '192.168.1.10', '::ffff:172.18.0.3'])('lets a private / loopback caller (%s) in', (ip) => {
    expect(guard().canActivate(ctx(ip))).toBe(true);
  });

  it('answers 404 to a public caller (as if the endpoint did not exist)', () => {
    expect(() => guard().canActivate(ctx('203.0.114.9'))).toThrow(expect.objectContaining({ code: 'NOT_FOUND', status: 404 }) as Error);
    expect(() => guard(TOKEN).canActivate(ctx('8.8.8.8'))).toThrow(expect.objectContaining({ status: 404 }) as Error);
  });

  it('lets a public caller in with the right METRICS_TOKEN only', () => {
    expect(guard(TOKEN).canActivate(ctx('8.8.8.8', `Bearer ${TOKEN}`))).toBe(true);
    expect(() => guard(TOKEN).canActivate(ctx('8.8.8.8', 'Bearer wrong-token-wrong-token-wrong-1'))).toThrow();
    expect(() => guard(TOKEN).canActivate(ctx('8.8.8.8', TOKEN))).toThrow();
  });

  it('with no METRICS_TOKEN configured a bearer header grants nothing', () => {
    expect(() => guard(undefined).canActivate(ctx('8.8.8.8', 'Bearer anything-anything-anything'))).toThrow();
  });
});
