import express, { json } from 'express';
import request from 'supertest';
import { AppException } from '../errors/app.exception';
import { ERROR_CODES } from '../errors/codes';
import { type AccessTokenVerifier, driverOnlyLargeJson } from './driver-large-json.middleware';

/** B-148 — the 14 MB `/mobile/signature` parser must never run for an unauthenticated caller. */
function buildApp(verifier: AccessTokenVerifier | null) {
  const app = express();
  app.use('/api/mobile/signature', driverOnlyLargeJson(verifier, '14mb'));
  app.use(json({ limit: '1mb' }));
  app.post('/api/mobile/signature', (req, res) => {
    res.json({ length: String((req.body as { base64?: string }).base64 ?? '').length });
  });
  return app;
}

const verifier: AccessTokenVerifier = {
  verifyAccessToken: jest.fn((token: string) => {
    if (token === 'driver-token') return Promise.resolve({ id: 'drv_1', type: 'driver' as const });
    if (token === 'user-token') return Promise.resolve({ id: 'usr_1', type: 'user' as const });
    return Promise.reject(new AppException(ERROR_CODES.TOKEN_INVALID, 'Invalid token.', 401));
  }),
};

// ~2 MB of JSON: over the global 1 MB limit, under the 14 MB invoice limit.
const big = { base64: 'A'.repeat(2 * 1024 * 1024) };

describe('driverOnlyLargeJson (B-148)', () => {
  it('parses a large body for a verified driver token', async () => {
    const res = await request(buildApp(verifier)).post('/api/mobile/signature').set('Authorization', 'Bearer driver-token').send(big);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ length: big.base64.length });
  });

  it.each([
    ['no Authorization header', undefined],
    ['a forged token', 'Bearer forged'],
    ['a back-office user token', 'Bearer user-token'],
    ['a non-bearer scheme', 'Basic abc'],
  ])('falls through to the 1 MB parser with %s (413, the big parser never runs)', async (_label, header) => {
    const req = request(buildApp(verifier)).post('/api/mobile/signature');
    if (header) req.set('Authorization', header);
    const res = await req.send(big);
    expect(res.status).toBe(413);
  });

  it('fails closed without a verifier', async () => {
    const res = await request(buildApp(null)).post('/api/mobile/signature').set('Authorization', 'Bearer driver-token').send(big);
    expect(res.status).toBe(413);
  });

  it('still accepts a small body from anyone (the guard, not the parser, rejects it later)', async () => {
    const res = await request(buildApp(verifier)).post('/api/mobile/signature').send({ base64: 'abc' });
    expect(res.status).toBe(200);
  });
});
