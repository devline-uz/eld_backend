/**
 * tz.md §18 / D-002 — proves the `AuditInterceptor` → `AuditSnapshotRegistry` → `diffSnapshots`
 * mechanism actually reaches the dev DB: a real `PATCH /roles/:id` writes an `AuditLog` row
 * whose `before`/`after` show only the fields that changed, and secret-shaped fields
 * (`keyHash`) never appear in a real `POST /api-keys` row. Boots the full Nest app (same
 * pattern as `auth.e2e-spec.ts`) so the whole interceptor/event-bus/registry chain runs for
 * real, not a mocked slice of it.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { authenticator } from 'otplib';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';
import { PERMISSION_KEYS } from '../../src/common/decorators/permission.types';

const prisma = new PrismaClient();

/** A full 22-key matrix (TZ §6.4) — `CreateRoleDto` rejects a partial one. */
const NONE_MATRIX = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'NONE'])) as Record<
  (typeof PERMISSION_KEYS)[number],
  'NONE'
>;

describe('AuditLog before/after (e2e, TZ §18 / D-002)', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    // Belt-and-suspenders cleanup (B-012): each test below already deletes the rows it
    // creates in a `finally`, but if a future assertion throws *before* that `finally` runs
    // (or the process is killed mid-test), a role/api-key with this run's prefix would
    // otherwise sit in the dev DB forever and break `seed-shape.spec.ts`'s exact counts.
    await prisma.role.deleteMany({ where: { key: { startsWith: 'E2E_AUDIT_ROLE_' } } });
    await app.close();
    await prisma.$disconnect();
  });

  /**
   * `AuditInterceptor` publishes fire-and-forget (TZ §18 — audit must never delay or break the
   * response it describes), so the row can land a beat after the HTTP response returns. Poll
   * briefly instead of asserting immediately.
   */
  async function waitForAuditRow(
    where: Parameters<typeof prisma.auditLog.findFirst>[0]['where'],
  ): Promise<Awaited<ReturnType<typeof prisma.auditLog.findFirst>>> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const row = await prisma.auditLog.findFirst({ where, orderBy: { id: 'desc' } });
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  async function adminToken(): Promise<string> {
    const login = await request(server())
      .post('/api/auth/login')
      .send({ email: 'sarah.chen@universal-logistics.example', password: 'Onebook2026' });
    const sarah = await prisma.user.findUnique({ where: { email: 'sarah.chen@universal-logistics.example' } });
    const code = authenticator.generate(sarah!.twoFactorSecret!);
    const verified = await request(server())
      .post('/api/auth/2fa/verify')
      .send({ pendingTwoFactorToken: login.body.data.pendingTwoFactorToken, code });
    return verified.body.data.accessToken as string;
  }

  it('PATCH /roles/:id writes a diff-only before/after showing exactly the changed field', async () => {
    const token = await adminToken();
    const key = `E2E_AUDIT_ROLE_${Date.now()}`;

    const created = await request(server())
      .post('/api/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ key, name: 'Before name', description: 'seed', permissions: NONE_MATRIX });
    expect(created.status).toBe(201);
    const roleId = created.body.data.id as string;

    try {
      const updated = await request(server())
        .patch(`/api/roles/${roleId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'After name' });
      expect(updated.status).toBe(200);

      const row = await waitForAuditRow({ objectType: 'Role', objectId: roleId, action: 'UPDATE' });
      expect(row).not.toBeNull();
      expect(row!.before).toMatchObject({ name: 'Before name' });
      expect(row!.after).toMatchObject({ name: 'After name' });
      // Untouched fields don't leak into the diff.
      expect(row!.before).not.toHaveProperty('key');
      expect(row!.after).not.toHaveProperty('key');
    } finally {
      // Runs even if an assertion above throws, so a failed run never leaks the row (B-012).
      await prisma.role.deleteMany({ where: { id: roleId } });
    }
  });

  it('DELETE /roles/:id records the deleted role as `before`, `after` null', async () => {
    const token = await adminToken();
    const key = `E2E_AUDIT_ROLE_DEL_${Date.now()}`;
    const created = await request(server())
      .post('/api/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ key, name: 'To be deleted', permissions: NONE_MATRIX });
    const roleId = created.body.data.id as string;

    try {
      const removed = await request(server())
        .delete(`/api/roles/${roleId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(removed.status).toBe(200);

      const row = await waitForAuditRow({ objectType: 'Role', objectId: roleId, action: 'DELETE' });
      expect(row).not.toBeNull();
      expect(row!.before).toMatchObject({ key });
      expect(row!.after).toBeNull();
    } finally {
      // The DELETE above should already have removed the row; deleteMany is a no-op then.
      // If an assertion threw before the DELETE request, this still cleans it up (B-012).
      await prisma.role.deleteMany({ where: { id: roleId } });
    }
  });

  it('POST /api-keys never leaks `keyHash` into the audit row', async () => {
    const token = await adminToken();
    const created = await request(server())
      .post('/api/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `e2e-audit-key-${Date.now()}`, scopes: ['reports:read'] });
    expect(created.status).toBe(201);
    const keyId = created.body.data.apiKey.id as string;

    try {
      const row = await waitForAuditRow({ objectType: 'ApiKey', objectId: keyId, action: 'CREATE' });
      expect(row).not.toBeNull();
      const after = row!.after as Record<string, unknown>;
      expect(after.keyHash).toBe('[REDACTED]');
      expect(JSON.stringify(row!.after)).not.toContain(created.body.data.plaintextKey as string);
    } finally {
      await prisma.apiKey.deleteMany({ where: { id: keyId } });
    }
  });
});
