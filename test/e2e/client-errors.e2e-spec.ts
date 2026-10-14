/**
 * D-158 — `POST /api/client-errors` through the real HTTP stack: public (no 401 even with a bad
 * token), 202 envelope, 422 field issues, 413 over the 32 KB cap. Forwarding itself is unit-tested
 * (`src/modules/client-errors/client-errors.spec.ts`); `.env.test` has no ERROR_REPORT_SECRET, so
 * nothing leaves the process here.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';

describe('POST /api/client-errors (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts one anonymous report with 202 { accepted }', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/client-errors')
      .send({ source: 'mobile', message: 'Null check operator used on a null value' })
      .expect(202);
    expect(res.body).toEqual(expect.objectContaining({ data: { accepted: 1 }, traceId: expect.any(String) }));
  });

  it('accepts a batch and ignores an invalid bearer token (no 401)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/client-errors')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ errors: [{ source: 'admin', message: 'a' }, { source: 'admin', level: 'fatal', message: 'b' }] })
      .expect(202);
    expect(res.body.data).toEqual({ accepted: 2 });
  });

  it('answers 422 VALIDATION_FAILED with field paths', async () => {
    const res = await request(app.getHttpServer()).post('/api/client-errors').send({ errors: [{ message: 'x' }] }).expect(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.details.issues[0].path).toBe('errors.0.source');
  });

  it('answers 413 PAYLOAD_TOO_LARGE over 32 KB', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/client-errors')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ source: 'mobile', message: 'x', stack: 's'.repeat(40 * 1024) }))
      .expect(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
