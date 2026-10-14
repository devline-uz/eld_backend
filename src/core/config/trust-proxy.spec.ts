import express from 'express';
import request from 'supertest';
import { resolveIpTracker } from '../../common/throttler/principal-tracker';
import { parseEnv } from './env.schema';
import { applyTrustProxy } from './trust-proxy';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://localhost:6379' };

function appWith(trustProxyEnv?: string) {
  const app = express();
  const env = parseEnv(trustProxyEnv === undefined ? base : { ...base, TRUST_PROXY: trustProxyEnv });
  applyTrustProxy(app, env.TRUST_PROXY);
  return app;
}

/** `req.ip` exactly as Express resolves it, for a peer at `socketAddress` sending `xff`. */
function ipFor(app: express.Express, socketAddress: string, xff?: string): string | undefined {
  const req = Object.create(app.request) as express.Request & { socket: { remoteAddress: string } };
  Object.defineProperty(req, 'socket', { value: { remoteAddress: socketAddress } });
  Object.defineProperty(req, 'headers', { value: xff === undefined ? {} : { 'x-forwarded-for': xff } });
  return req.ip;
}

describe('trust proxy (CODE-004)', () => {
  it('default (loopback): the client IP forwarded by a same-host proxy becomes req.ip', () => {
    const app = appWith();
    expect(ipFor(app, '127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    expect(ipFor(app, '::1', '198.51.100.9')).toBe('198.51.100.9');
  });

  it('different clients behind the proxy get different throttler buckets', () => {
    const app = appWith();
    const a = resolveIpTracker({ ip: ipFor(app, '127.0.0.1', '203.0.113.7') });
    const b = resolveIpTracker({ ip: ipFor(app, '127.0.0.1', '198.51.100.9') });
    expect(a).toBe('ip:203.0.113.7');
    expect(b).toBe('ip:198.51.100.9');
  });

  it('a client connecting directly cannot spoof its IP with X-Forwarded-For', () => {
    const app = appWith();
    expect(ipFor(app, '203.0.113.50', '1.2.3.4')).toBe('203.0.113.50');
    expect(ipFor(app, '10.0.0.8', '127.0.0.1')).toBe('10.0.0.8');
  });

  it('a spoofed X-Forwarded-For prefix sent through the proxy is ignored (rightmost untrusted hop wins)', () => {
    const app = appWith();
    // client sent "XFF: 1.2.3.4, 127.0.0.1"; the proxy appended the real peer 203.0.113.7
    expect(ipFor(app, '127.0.0.1', '1.2.3.4, 127.0.0.1, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('a configured docker subnet is trusted as well, other private ranges are not', () => {
    const app = appWith('loopback,172.16.0.0/12');
    expect(ipFor(app, '172.18.0.1', '203.0.113.7')).toBe('203.0.113.7');
    expect(ipFor(app, '192.168.1.20', '203.0.113.7')).toBe('192.168.1.20');
  });

  it('TRUST_PROXY=false ignores X-Forwarded-For even from loopback', () => {
    expect(ipFor(appWith('false'), '127.0.0.1', '203.0.113.7')).toBe('127.0.0.1');
  });

  it('end to end over a real socket: loopback proxy hop is honoured', async () => {
    const app = appWith();
    app.get('/ip', (req, res) => {
      res.json({ ip: req.ip });
    });
    const res = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.7');
    expect(res.body).toEqual({ ip: '203.0.113.7' });
  });
});
