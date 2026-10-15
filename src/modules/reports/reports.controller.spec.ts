import 'reflect-metadata';
import type { Server } from 'http';
import { INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * BE-05 — `GET /reports/:id/file` must send the real file bytes. With
 * `@Res({ passthrough: true })` + `return buffer`, the Express adapter JSON-serialised the
 * Buffer into `{"type":"Buffer","data":[...]}`. Runs a real Nest HTTP app (no DB) with the
 * global success-envelope interceptor so both the adapter and the envelope are exercised.
 */
describe('ReportsController GET /reports/:id/file (BE-05)', () => {
  let app: INestApplication;
  const service = { file: jest.fn() };
  const server = () => app.getHttpServer() as Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        { provide: ReportsService, useValue: service },
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('CSV: raw bytes, text/csv, attachment filename, not the envelope or a JSON Buffer', async () => {
    const csv = 'Jurisdiction,Total miles,Taxable miles\nOH,42,42\n';
    service.file.mockResolvedValueOnce({ fileName: 'rpt_1.csv', contentType: 'text/csv; charset=utf-8', body: Buffer.from(csv) });

    const res = await request(server()).get('/reports/rpt_1/file').expect(200);

    expect(service.file).toHaveBeenCalledWith('rpt_1', undefined);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="rpt_1.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toBe(csv);
    expect(res.text).not.toContain('"type":"Buffer"');
  });

  it('PDF: binary body is byte-for-byte the generated file', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0x00, 0xff, 0x80, 0x0a]), Buffer.from('%%EOF')]);
    service.file.mockResolvedValueOnce({ fileName: 'rpt_2.pdf', contentType: 'application/pdf', body: pdf });

    const res = await request(server())
      .get('/reports/rpt_2/file')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="rpt_2.pdf"');
    expect(Buffer.compare(res.body as Buffer, pdf)).toBe(0);
  });
});
