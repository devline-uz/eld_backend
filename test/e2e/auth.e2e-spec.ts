/**
 * tz.md §21 — "100% happy path + auth rejection" for every endpoint added in Phase 1
 * (modules/auth, modules/roles, modules/users, modules/audit, modules/api-keys). Boots the
 * real Nest app (full guard/interceptor chain) against the dev DB seed.
 *
 * Success responses go through `TransformInterceptor` (`{ data, traceId, timestamp }`);
 * error responses are the flat TZ §20 envelope (`{ code, message, ... }`).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { authenticator } from 'otplib';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';
import { DEFAULT_ROLE_MATRIX } from '../../src/modules/roles/permission-matrix';

const prisma = new PrismaClient();

describe('Auth / Roles / Users / Audit / API keys (e2e)', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  // -----------------------------------------------------------------------
  // Password login — User
  // -----------------------------------------------------------------------
  describe('POST /auth/login (User, TZ §6.1)', () => {
    const path = '/api/auth/login';

    it('rejects a wrong password with 401 INVALID_CREDENTIALS', async () => {
      const res = await request(server())
        .post(path)
        .send({ email: 'carlos.ramirez@universal-logistics.example', password: 'wrong' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects an unknown email with 401 INVALID_CREDENTIALS (no user-enumeration oracle)', async () => {
      const res = await request(server())
        .post(path)
        .send({ email: 'nobody@universal-logistics.example', password: 'whatever' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects a malformed body with 422 VALIDATION_FAILED', async () => {
      const res = await request(server()).post(path).send({ email: 'not-an-email' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('happy path (2FA off — DISPATCHER): returns access + refresh tokens directly', async () => {
      const res = await request(server())
        .post(path)
        .send({ email: 'carlos.ramirez@universal-logistics.example', password: 'Onebook2026' });
      expect(res.status).toBe(201);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(res.body.data.refreshToken).toEqual(expect.any(String));
      expect(res.body.data.twoFactorRequired).toBeUndefined();
    });

    it('happy path (2FA on — ADMIN): returns a pendingTwoFactorToken, not real tokens', async () => {
      const res = await request(server())
        .post(path)
        .send({ email: 'sarah.chen@universal-logistics.example', password: 'Onebook2026' });
      expect(res.status).toBe(201);
      expect(res.body.data.twoFactorRequired).toBe(true);
      expect(res.body.data.pendingTwoFactorToken).toEqual(expect.any(String));
      expect(res.body.data.accessToken).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 2FA verify + the "ADMIN locked to /me/* until 2FA" gate
  // -----------------------------------------------------------------------
  describe('POST /auth/2fa/verify + TwoFactorSetupGuard (TZ §6.2)', () => {
    it('rejects a wrong TOTP code with 401 TWO_FACTOR_INVALID', async () => {
      const login = await request(server())
        .post('/api/auth/login')
        .send({ email: 'sarah.chen@universal-logistics.example', password: 'Onebook2026' });
      const res = await request(server())
        .post('/api/auth/2fa/verify')
        .send({ pendingTwoFactorToken: login.body.data.pendingTwoFactorToken, code: '000000' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('TWO_FACTOR_INVALID');
    });

    it('happy path: correct TOTP code (computed from the DB secret) completes login', async () => {
      const login = await request(server())
        .post('/api/auth/login')
        .send({ email: 'sarah.chen@universal-logistics.example', password: 'Onebook2026' });

      const sarah = await prisma.user.findUnique({
        where: { email: 'sarah.chen@universal-logistics.example' },
      });
      const code = authenticator.generate(sarah!.twoFactorSecret!);

      const res = await request(server())
        .post('/api/auth/2fa/verify')
        .send({ pendingTwoFactorToken: login.body.data.pendingTwoFactorToken, code });
      expect(res.status).toBe(201);
      expect(res.body.data.accessToken).toEqual(expect.any(String));

      // The resulting token carries twoFactorEnabled=true, so /users (an ADMIN-only,
      // non-exempt route) is reachable — the TwoFactorSetupGuard does NOT block it.
      const users = await request(server())
        .get('/api/users')
        .set('Authorization', `Bearer ${res.body.data.accessToken as string}`);
      expect(users.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Google Sign-In never bypasses 2FA (TZ §6.2, hard rule)
  // -----------------------------------------------------------------------
  describe('POST /auth/google (TZ §6.2 — never bypasses 2FA, no auto-registration)', () => {
    it('rejects an invalid/unverifiable ID token with 401 or 503 — never with real tokens', async () => {
      const res = await request(server()).post('/api/auth/google').send({ idToken: 'not-a-real-firebase-token' });
      expect([401, 503]).toContain(res.status);
      expect(res.body.data?.accessToken).toBeUndefined();
    });

    it('rejects a malformed body with 422 VALIDATION_FAILED', async () => {
      const res = await request(server()).post('/api/auth/google').send({});
      expect(res.status).toBe(422);
    });
  });

  // -----------------------------------------------------------------------
  // Driver login + refresh rotation + reuse detection (TZ §6.1 / §6.5)
  // -----------------------------------------------------------------------
  describe('POST /auth/login/driver + /auth/refresh (TZ §6.1, §6.5)', () => {
    it('rejects a wrong password with 401 INVALID_CREDENTIALS', async () => {
      const res = await request(server()).post('/api/auth/login/driver').send({ username: 'johnsmith', password: 'wrong' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('happy path: driver gets access + refresh tokens, no 2FA involved', async () => {
      const res = await request(server()).post('/api/auth/login/driver').send({ username: 'johnsmith', password: 'Onebook2026' });
      expect(res.status).toBe(201);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(res.body.data.refreshToken).toEqual(expect.any(String));
    });

    it('rotates the refresh token on use, and rejects reuse of the old one (REFRESH_TOKEN_REUSED)', async () => {
      const login = await request(server()).post('/api/auth/login/driver').send({ username: 'johnsmith', password: 'Onebook2026' });
      const first = login.body.data.refreshToken as string;

      const rotated = await request(server())
        .post('/api/auth/refresh')
        .send({ refreshToken: first, subjectType: 'driver' });
      expect(rotated.status).toBe(201);
      expect(rotated.body.data.refreshToken).not.toBe(first);

      const reused = await request(server())
        .post('/api/auth/refresh')
        .send({ refreshToken: first, subjectType: 'driver' });
      expect(reused.status).toBe(401);
      expect(reused.body.code).toBe('REFRESH_TOKEN_REUSED');
    });

    it('a driver token cannot be used against a back-office endpoint requiring `users` permission', async () => {
      const login = await request(server()).post('/api/auth/login/driver').send({ username: 'johnsmith', password: 'Onebook2026' });
      const res = await request(server())
        .get('/api/users')
        .set('Authorization', `Bearer ${login.body.data.accessToken as string}`);
      expect(res.status).toBe(403);
    });
  });

  // -----------------------------------------------------------------------
  // Bearer-token rejection on every guarded route
  // -----------------------------------------------------------------------
  describe('Auth rejection (no token / bad token)', () => {
    it.each(['/api/users', '/api/roles', '/api/audit-log', '/api/api-keys', '/api/auth/me'])(
      'GET %s without a token returns 401 UNAUTHORIZED',
      async (path) => {
        const res = await request(server()).get(path);
        expect(res.status).toBe(401);
      },
    );

    it('a garbage bearer token returns 401 TOKEN_INVALID', async () => {
      const res = await request(server()).get('/api/auth/me').set('Authorization', 'Bearer garbage');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });
  });

  // -----------------------------------------------------------------------
  // Permission matrix (TZ §6.4) — every non-driver role, table-driven off the real
  // `DEFAULT_ROLE_MATRIX` (not a hand-copied expectation) against the only guarded
  // GET routes Phase 1 ships (`users`/`roles`/`auditLog` — every non-ADMIN seeded
  // role is NONE on all three, so this doubles as the "reject" half of the
  // FULL/READ/NONE triad; the FULL/READ-allow half and the driver-denied case are
  // covered unit-level in `src/common/guards/permission.guard.spec.ts` since no
  // Phase 1 endpoint yet exposes a READ- or FULL-gated key to a non-ADMIN role).
  // -----------------------------------------------------------------------
  describe('PermissionGuard end-to-end — DISPATCHER / FLEET_MANAGER / VIEWER (TZ §6.4)', () => {
    const roleLogin: Record<'DISPATCHER' | 'FLEET_MANAGER' | 'VIEWER', string> = {
      DISPATCHER: 'carlos.ramirez@universal-logistics.example',
      FLEET_MANAGER: 'linda.park@universal-logistics.example',
      VIEWER: 'kevin.brooks@universal-logistics.example',
    };
    const tokenCache = new Map<string, string>();

    async function tokenFor(role: keyof typeof roleLogin): Promise<string> {
      const cached = tokenCache.get(role);
      if (cached) return cached;
      const res = await request(server())
        .post('/api/auth/login')
        .send({ email: roleLogin[role], password: 'Onebook2026' });
      const token = res.body.data.accessToken as string;
      tokenCache.set(role, token);
      return token;
    }

    const endpoints: { path: string; key: 'users' | 'roles' | 'auditLog' }[] = [
      { path: '/api/users', key: 'users' },
      { path: '/api/roles', key: 'roles' },
      { path: '/api/audit-log', key: 'auditLog' },
    ];

    describe.each(Object.keys(roleLogin) as (keyof typeof roleLogin)[])('%s', (role) => {
      it.each(endpoints)('GET $path — expects the level the real matrix grants', async ({ path, key }) => {
        const granted = DEFAULT_ROLE_MATRIX[role][key];
        const token = await tokenFor(role);
        const res = await request(server()).get(path).set('Authorization', `Bearer ${token}`);
        if (granted === 'NONE') {
          expect(res.status).toBe(403);
          expect(res.body.details).toMatchObject({ key, required: 'READ', granted: 'NONE' });
        } else {
          expect(res.status).toBe(200);
        }
      });
    });
  });

  // -----------------------------------------------------------------------
  // Roles / Users / Audit / API keys — ADMIN happy path (TZ §18 — audit)
  // -----------------------------------------------------------------------
  describe('Roles / Users / Audit (ADMIN happy path, TZ §18 — audit)', () => {
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

    it('GET /roles lists all 4 seeded roles, ADMIN is isSystem', async () => {
      const token = await adminToken();
      const res = await request(server()).get('/api/roles').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      // B-012: filter out any `E2E_AUDIT_ROLE_*` row left by a prior failed run of
      // `audit-before-after.e2e-spec.ts` (now cleaned up in a `finally` there, but this keeps
      // the assertion robust against pollution predating that fix without hiding a real count
      // regression for genuinely seeded roles).
      const seeded = res.body.data.filter((r: { key: string }) => !r.key.startsWith('E2E_AUDIT_ROLE_'));
      expect(seeded).toHaveLength(4);
      const admin = seeded.find((r: { key: string }) => r.key === 'ADMIN');
      expect(admin.isSystem).toBe(true);
    });

    it('PATCH on the ADMIN role is rejected with 403 ROLE_IMMUTABLE', async () => {
      const token = await adminToken();
      const roles = await request(server()).get('/api/roles').set('Authorization', `Bearer ${token}`);
      const admin = roles.body.data.find((r: { key: string }) => r.key === 'ADMIN');
      const res = await request(server())
        .patch(`/api/roles/${admin.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed Admin' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ROLE_IMMUTABLE');
    });

    it('inviting a user is recorded in the audit log (TZ §18 mandatory: user invite)', async () => {
      const token = await adminToken();
      const roles = await request(server()).get('/api/roles').set('Authorization', `Bearer ${token}`);
      const viewerRole = roles.body.data.find((r: { key: string }) => r.key === 'VIEWER');

      const email = `e2e-${Date.now()}@universal-logistics.example`;
      const invite = await request(server())
        .post('/api/users')
        .set('Authorization', `Bearer ${token}`)
        .send({ email, firstName: 'E2E', lastName: 'Tester', roleId: viewerRole.id });
      expect(invite.status).toBe(201);
      const userId = invite.body.data.user.id as string;

      try {
        expect(invite.body.data.inviteToken).toEqual(expect.any(String));
        expect(invite.body.data.user.passwordHash).toBeUndefined();

        const auditRes = await request(server())
          .get('/api/audit-log?objectType=User')
          .set('Authorization', `Bearer ${token}`);
        expect(auditRes.status).toBe(200);
        expect(auditRes.body.data.items.length).toBeGreaterThan(0);
        expect(auditRes.body.data.items[0].action).toBe('INVITE');
      } finally {
        // Clean up even if an assertion above throws (B-012) — the dev DB seed shape
        // (12 users) is asserted by test/integration/seed-shape.spec.ts.
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    });

    it('creates and revokes an API key without ever exposing the stored hash', async () => {
      const token = await adminToken();
      const created = await request(server())
        .post('/api/api-keys')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'e2e key', scopes: ['reports:read'] });
      expect(created.status).toBe(201);
      expect(created.body.data.plaintextKey).toEqual(expect.any(String));
      expect(created.body.data.apiKey.keyHash).toBeUndefined();

      const revoked = await request(server())
        .delete(`/api/api-keys/${created.body.data.apiKey.id as string}`)
        .set('Authorization', `Bearer ${token}`);
      expect(revoked.status).toBe(200);
    });

    it('an issued API key authenticates a request scoped to its own permissions, then a revoked key is rejected (TZ §6.5 "issued, used, revoked")', async () => {
      const token = await adminToken();
      const created = await request(server())
        .post('/api/api-keys')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'e2e key — used', scopes: ['integrations:read'] });
      expect(created.status).toBe(201);
      const plaintextKey = created.body.data.plaintextKey as string;
      const keyId = created.body.data.apiKey.id as string;

      try {
        // Granted scope (integrations:read) — the key authenticates and is authorized.
        const withinScope = await request(server())
          .get('/api/integrations')
          .set('Authorization', `Bearer ${plaintextKey}`);
        expect(withinScope.status).toBe(200);

        // Out of scope (carrierSettings has no matching scope) — authenticates but 403s,
        // same as an under-permissioned user would.
        const outOfScope = await request(server())
          .get('/api/carrier')
          .set('Authorization', `Bearer ${plaintextKey}`);
        expect(outOfScope.status).toBe(403);

        await request(server())
          .delete(`/api/api-keys/${keyId}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        // Revoked — no longer authenticates at all.
        const afterRevoke = await request(server())
          .get('/api/integrations')
          .set('Authorization', `Bearer ${plaintextKey}`);
        expect(afterRevoke.status).toBe(401);
        expect(afterRevoke.body.code).toBe('API_KEY_REVOKED');
      } finally {
        await prisma.apiKey.deleteMany({ where: { id: keyId } });
      }
    });
  });
});
