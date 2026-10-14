import type { ArgumentMetadata } from '@nestjs/common';
import type { AppConfigService } from '../../core/config/config.service';
import { AppException } from '../../common/errors/app.exception';
import { RequestContext } from '../../core/context/request-context';
import { ClientErrorForwarder, CLIENT_ERROR_FORWARD_TIMEOUT_MS, type ErrorBotReport } from './client-error-forwarder';
import { scrubSecrets } from './client-error-scrub';
import { ClientErrorsService, toBotReport } from './client-errors.service';
import { ClientErrorsValidationPipe } from './dto/client-errors.dto';

const META: ArgumentMetadata = { type: 'body' };
const pipe = new ClientErrorsValidationPipe();

function issuesOf(fn: () => unknown): Array<{ path: string; code: string }> {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppException);
    const ex = err as AppException;
    expect(ex.getStatus()).toBe(422);
    return ((ex.getResponse() as { details: { issues: Array<{ path: string; code: string }> } }).details).issues;
  }
  throw new Error('expected a validation failure');
}

describe('ClientErrorsValidationPipe', () => {
  it('accepts a single object and defaults level to error', () => {
    const out = pipe.transform({ source: 'mobile', message: 'boom', extra: 'stripped' }, META);
    expect(out).toEqual([{ source: 'mobile', level: 'error', message: 'boom' }]);
  });

  it('accepts a batch of up to 10 items', () => {
    const item = { source: 'admin', level: 'fatal', message: 'x', occurredAt: '2026-10-14T10:00:00.000Z' };
    expect(pipe.transform({ errors: Array(10).fill(item) }, META)).toHaveLength(10);
  });

  it('rejects an 11-item batch and an empty batch', () => {
    const item = { source: 'admin', message: 'x' };
    expect(issuesOf(() => pipe.transform({ errors: Array(11).fill(item) }, META))[0].path).toBe('errors');
    expect(issuesOf(() => pipe.transform({ errors: [] }, META))[0].path).toBe('errors');
  });

  it('reports field-level issues, not invalid_union', () => {
    expect(issuesOf(() => pipe.transform({ message: 'x' }, META))).toEqual([expect.objectContaining({ path: 'source' })]);
    expect(issuesOf(() => pipe.transform({ errors: [{ source: 'web', message: 'x' }] }, META))[0].path).toBe('errors.0.source');
  });

  it('enforces the length limits and ISO occurredAt', () => {
    const paths = issuesOf(() =>
      pipe.transform(
        {
          source: 'mobile',
          level: 'warn',
          message: '',
          stack: 's'.repeat(8001),
          url: 'u'.repeat(501),
          route: 'r'.repeat(201),
          appVersion: 'v'.repeat(41),
          platform: 'p'.repeat(41),
          device: 'd'.repeat(81),
          release: 'x'.repeat(81),
          occurredAt: 'yesterday',
        },
        META,
      ),
    ).map((i) => i.path);
    expect(paths.sort()).toEqual(['appVersion', 'device', 'level', 'message', 'occurredAt', 'platform', 'release', 'route', 'stack', 'url'].sort());
    expect(issuesOf(() => pipe.transform({ source: 'mobile', message: 'm'.repeat(1001) }, META))[0].path).toBe('message');
  });

  it('rejects non-object bodies', () => {
    expect(issuesOf(() => pipe.transform([{ source: 'mobile', message: 'x' }], META)).length).toBeGreaterThan(0);
    expect(issuesOf(() => pipe.transform(undefined, META)).length).toBeGreaterThan(0);
  });
});

describe('scrubSecrets', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcDEF123_-xyz';

  it('removes Bearer tokens and bare JWTs', () => {
    expect(scrubSecrets('Authorization: Bearer abc.def-123')).not.toContain('abc.def-123');
    expect(scrubSecrets(`token was ${jwt} in url`)).toBe('token was [REDACTED] in url');
  });

  it('removes refreshToken/accessToken/password values in JSON and query strings', () => {
    const out = scrubSecrets(`{"refreshToken":"r3fr3sh","accessToken": "acc","password":"hunter2"} ?password=p4ss&x=1 access_token=zz`);
    for (const secret of ['r3fr3sh', '"acc"', 'hunter2', 'p4ss', 'zz']) expect(out).not.toContain(secret);
    expect(out).toContain('"refreshToken":"[REDACTED]"');
    expect(out).toContain('&x=1');
  });

  it('removes email addresses and leaves ordinary text alone', () => {
    expect(scrubSecrets('login failed for john.smith+1@example.co.uk')).toBe('login failed for [EMAIL]');
    expect(scrubSecrets('TypeError: x is undefined at Foo (main.dart:12)')).toBe('TypeError: x is undefined at Foo (main.dart:12)');
  });
});

describe('toBotReport', () => {
  it('maps fields, scrubs every string and uses the first message line as title', () => {
    const report = toBotReport(
      {
        source: 'admin',
        level: 'fatal',
        message: 'Failed for a@b.io\nsecond line',
        stack: 'at Bearer xyz',
        url: 'https://eldadmin/x?accessToken=abc',
        route: '/drivers',
        appVersion: '1.2.3',
        platform: 'web',
        device: 'Chrome',
        release: 'r1',
        occurredAt: '2026-10-14T10:00:00Z',
      },
      'user:u1',
      'trace-1',
    );
    expect(report).toEqual({
      source: 'admin',
      level: 'fatal',
      title: 'Failed for [EMAIL]',
      message: 'Failed for [EMAIL]\nsecond line',
      stack: 'at Bearer [REDACTED]',
      url: 'https://eldadmin/x?accessToken=[REDACTED]',
      route: '/drivers',
      appVersion: '1.2.3',
      platform: 'web',
      device: 'Chrome',
      release: 'r1',
      user: 'user:u1',
      traceId: 'trace-1',
      time: '2026-10-14T10:00:00Z',
    });
  });
});

function configWith(env: Record<string, string | undefined>): AppConfigService {
  return { get: (key: string) => env[key] } as unknown as AppConfigService;
}

describe('ClientErrorForwarder', () => {
  const fetchMock = jest.fn();
  const realFetch = global.fetch;
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });
  const report = { source: 'mobile' as const, level: 'error' as const, title: 't', message: 't' };

  it('posts to ERROR_REPORT_URL with X-Report-Secret and a short timeout', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    new ClientErrorForwarder(configWith({ ERROR_REPORT_URL: 'http://127.0.0.1:8790/report', ERROR_REPORT_SECRET: 's3' })).forward([report, report]);
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('http://127.0.0.1:8790/report');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Report-Secret']).toBe('s3');
    expect(JSON.parse(init.body as string)).toEqual([report, report]);
    expect(timeoutSpy).toHaveBeenCalledWith(CLIENT_ERROR_FORWARD_TIMEOUT_MS);
    timeoutSpy.mockRestore();
  });

  it('sends a single report as an object', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    new ClientErrorForwarder(configWith({ ERROR_REPORT_URL: 'http://x/report', ERROR_REPORT_SECRET: 's' })).forward([report]);
    await new Promise((r) => setImmediate(r));
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual(report);
  });

  it('drops reports when the secret is unset or empty', () => {
    new ClientErrorForwarder(configWith({ ERROR_REPORT_URL: 'http://x/report' })).forward([report]);
    new ClientErrorForwarder(configWith({ ERROR_REPORT_URL: 'http://x/report', ERROR_REPORT_SECRET: '' })).forward([report]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws or logs at error level when the bot is down', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const forwarder = new ClientErrorForwarder(configWith({ ERROR_REPORT_URL: 'http://x/report', ERROR_REPORT_SECRET: 's' }));
    const logger = (forwarder as unknown as { logger: { warn: jest.Mock; error: jest.Mock } }).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    expect(() => forwarder.forward([report])).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(warn).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('ClientErrorsService', () => {
  const forward = jest.fn<void, [ErrorBotReport[]]>();
  const verifyAccessToken = jest.fn();
  const service = new ClientErrorsService(
    { verifyAccessToken },
    { forward } as unknown as ClientErrorForwarder,
  );
  const items = [{ source: 'mobile' as const, level: 'error' as const, message: 'boom' }];
  beforeEach(() => {
    forward.mockReset();
    verifyAccessToken.mockReset();
  });

  it('accepts anonymously without a token', async () => {
    await expect(service.report(items, undefined)).resolves.toEqual({ accepted: 1 });
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(forward.mock.calls[0][0][0].user).toBeUndefined();
  });

  it('attaches driver:<id> / user:<id> for a valid access token', async () => {
    verifyAccessToken.mockResolvedValueOnce({ id: 'd1', type: 'driver' });
    await service.report(items, 'Bearer good');
    expect(verifyAccessToken).toHaveBeenCalledWith('good');
    expect(forward.mock.calls[0][0][0].user).toBe('driver:d1');
    verifyAccessToken.mockResolvedValueOnce({ id: 'u7', type: 'user', role: 'admin' });
    await service.report(items, 'Bearer good');
    expect(forward.mock.calls[1][0][0].user).toBe('user:u7');
  });

  it('ignores an invalid or expired token (no 401)', async () => {
    verifyAccessToken.mockRejectedValue(new AppException('TOKEN_EXPIRED', 'expired', 401));
    await expect(service.report(items, 'Bearer expired')).resolves.toEqual({ accepted: 1 });
    expect(forward.mock.calls[0][0][0].user).toBeUndefined();
  });

  it('ignores API keys and non-Bearer schemes', async () => {
    await service.report(items, 'Bearer obk_abc');
    await service.report(items, 'Basic abc');
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it('carries the request traceId', async () => {
    await RequestContext.run({ requestId: 'r', traceId: 'tr-9', startedAt: 0 }, () => service.report(items, undefined));
    expect(forward.mock.calls[0][0][0].traceId).toBe('tr-9');
  });
});
