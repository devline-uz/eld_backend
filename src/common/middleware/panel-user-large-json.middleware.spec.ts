import express, { json } from 'express';
import request from 'supertest';
import { AppException } from '../errors/app.exception';
import { ERROR_CODES } from '../errors/codes';
import type { AccessTokenVerifier } from './driver-large-json.middleware';
import { panelUserLargeJson } from './panel-user-large-json.middleware';

/** The 4 MB `/vehicles/import` parser must only run for a verified back-office user token. */
function buildApp(verifier: AccessTokenVerifier | null) {
  const app = express();
  app.use('/api/vehicles/import', panelUserLargeJson(verifier, '4mb'));
  app.use(json({ limit: '1mb' }));
  app.post('/api/vehicles/import', (req, res) => {
    res.json({ rows: ((req.body as { vehicles?: unknown[] }).vehicles ?? []).length });
  });
  return app;
}

const verifier: AccessTokenVerifier = {
  verifyAccessToken: jest.fn((token: string) => {
    if (token === 'user-token') return Promise.resolve({ id: 'usr_1', type: 'user' as const });
    if (token === 'driver-token') return Promise.resolve({ id: 'drv_1', type: 'driver' as const });
    return Promise.reject(new AppException(ERROR_CODES.TOKEN_INVALID, 'Invalid token.', 401));
  }),
};

// 2,000 worst-case-ish rows (~1 KB each, ~2 MB): over the global 1 MB limit, under 4 MB.
const big = {
  vehicles: Array.from({ length: 2000 }, (_, i) => ({ unitNumber: `U${i}`, vin: '1FUJGLDR8LLLL0000', notes: 'n'.repeat(500), make: 'm'.repeat(60), model: 'x'.repeat(60) })),
};

describe('panelUserLargeJson (vehicle import, 2,000 rows)', () => {
  it('parses a 2,000-row (~2 MB) body for a verified back-office user token', async () => {
    const res = await request(buildApp(verifier)).post('/api/vehicles/import').set('Authorization', 'Bearer user-token').send(big);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: 2000 });
  });

  it.each([
    ['no Authorization header', undefined],
    ['a forged token', 'Bearer forged'],
    ['a driver token', 'Bearer driver-token'],
    ['a non-bearer scheme', 'Basic abc'],
  ])('falls through to the 1 MB parser with %s (413)', async (_label, header) => {
    const req = request(buildApp(verifier)).post('/api/vehicles/import');
    if (header) req.set('Authorization', header);
    const res = await req.send(big);
    expect(res.status).toBe(413);
  });

  it('fails closed without a verifier', async () => {
    const res = await request(buildApp(null)).post('/api/vehicles/import').set('Authorization', 'Bearer user-token').send(big);
    expect(res.status).toBe(413);
  });
});
