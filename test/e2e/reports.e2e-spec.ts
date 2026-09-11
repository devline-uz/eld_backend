/**
 * tz.md §11.6/§15 (tasks.md Phase 8) — Reports HTTP surface, against the real dev DB.
 *
 * Asserts the hard rule from tz.md §15: `POST /reports/generate` NEVER generates inline —
 * it returns `202 { reportId, status: "QUEUED" }` and a real BullMQ job lands on the
 * `report` queue. `GET /reports/:id/download` 409s (`REPORT_NOT_READY`) for a report the
 * worker has not processed yet — the API only enqueues.
 */
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { authenticator } from 'otplib';
import { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';
import { QUEUES } from '../../src/core/queue/queue.constants';

const prisma = new PrismaClient();

describe('Reports (e2e, tz.md §11.6/§15)', () => {
  let app: INestApplication;
  let token: string;
  const server = () => app.getHttpServer();

  const createdReportIds: string[] = [];
  const createdScheduleIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const login = await request(server())
      .post('/api/auth/login')
      .send({ email: 'sarah.chen@universal-logistics.example', password: 'Onebook2026' });
    const sarah = await prisma.user.findUnique({ where: { email: 'sarah.chen@universal-logistics.example' } });
    const code = authenticator.generate(sarah!.twoFactorSecret!);
    const verified = await request(server())
      .post('/api/auth/2fa/verify')
      .send({ pendingTwoFactorToken: login.body.data.pendingTwoFactorToken, code });
    token = verified.body.data.accessToken as string;
    expect(token).toEqual(expect.any(String));
  });

  afterAll(async () => {
    await prisma.reportSchedule.deleteMany({ where: { id: { in: createdScheduleIds } } });
    await prisma.report.deleteMany({ where: { id: { in: createdReportIds } } });
    await app.close();
    await prisma.$disconnect();
  });

  it('POST /reports/generate returns 202 QUEUED and never a generated file (§15)', async () => {
    const res = await request(server())
      .post('/api/reports/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'ACTIVITY', format: 'CSV', params: { from: '2026-09-01', to: '2026-09-02' } });

    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ status: 'QUEUED' });
    expect(res.body.data.reportId).toEqual(expect.any(String));
    createdReportIds.push(res.body.data.reportId);

    const row = await prisma.report.findUniqueOrThrow({ where: { id: res.body.data.reportId } });
    expect(row.status).toBe('QUEUED');
    expect(row.fileKey).toBeNull();
  });

  it('actually enqueues a report.generate BullMQ job on the report queue', async () => {
    const queue = app.get<Queue>(getQueueToken(QUEUES.REPORT));
    const res = await request(server())
      .post('/api/reports/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'DVIR', format: 'CSV', params: { from: '2026-09-01', to: '2026-09-02' } });
    createdReportIds.push(res.body.data.reportId);

    const job = await queue.getJob(`report-${res.body.data.reportId}`);
    expect(job).not.toBeNull();
    expect(job?.name).toBe('report.generate');
    expect(job?.data).toEqual({ reportId: res.body.data.reportId });
  });

  it('rejects an unsupported format for a report type with 422 VALIDATION_FAILED', async () => {
    const res = await request(server())
      .post('/api/reports/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'IFTA', format: 'PDF', params: { quarter: '2026-Q3' } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('GET /reports/:id/download 409s with REPORT_NOT_READY before the worker has processed the job', async () => {
    const gen = await request(server())
      .post('/api/reports/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'ACTIVITY', format: 'CSV', params: { from: '2026-09-01', to: '2026-09-02' } });
    createdReportIds.push(gen.body.data.reportId);

    const res = await request(server())
      .get(`/api/reports/${gen.body.data.reportId}/download`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REPORT_NOT_READY');
  });

  it('GET /reports/:id 404s for an unknown report', async () => {
    const res = await request(server())
      .get('/api/reports/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('GET /reports lists queued jobs', async () => {
    const res = await request(server()).get('/api/reports').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual(expect.any(Array));
  });

  it('POST /reports/schedules persists a cron-based ReportSchedule with a computed nextRunAt (report scheduler DB contract)', async () => {
    const res = await request(server())
      .post('/api/reports/schedules')
      .set('Authorization', `Bearer ${token}`)
      .send({ reportType: 'ACTIVITY', format: 'CSV', params: { from: '2026-09-01', to: '2026-09-02' }, cron: '0 6 * * 1', timezone: 'UTC', recipients: [], enabled: true });

    expect(res.status).toBe(201);
    expect(res.body.data.nextRunAt).toEqual(expect.any(String));
    createdScheduleIds.push(res.body.data.id);

    const row = await prisma.reportSchedule.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(row.nextRunAt).not.toBeNull();
  });

  it('POST /reports/schedules rejects an invalid cron expression with 422 INVALID_CRON_EXPRESSION', async () => {
    const res = await request(server())
      .post('/api/reports/schedules')
      .set('Authorization', `Bearer ${token}`)
      .send({ reportType: 'ACTIVITY', format: 'CSV', params: {}, cron: 'not a cron', timezone: 'UTC', recipients: [], enabled: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_CRON_EXPRESSION');
  });

  it('GET /reports/ifta shortcut queues an IFTA report with the quarter param', async () => {
    const res = await request(server())
      .get('/api/reports/ifta')
      .query({ quarter: '2026-Q3' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(202);
    createdReportIds.push(res.body.data.reportId);
    const row = await prisma.report.findUniqueOrThrow({ where: { id: res.body.data.reportId } });
    expect(row.type).toBe('IFTA');
    expect(row.params).toMatchObject({ quarter: '2026-Q3' });
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(server()).get('/api/reports');
    expect(res.status).toBe(401);
  });
});
