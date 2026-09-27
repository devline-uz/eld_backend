import { Test } from '@nestjs/testing';
import { AppConfigService } from '../../core/config/config.service';
import { parseEnv } from '../../core/config/env.schema';
import { AppException } from '../../common/errors/app.exception';
import { TokenService } from './token.service';

/** TZ §6.3 — token contents. */
describe('TokenService', () => {
  let tokens: TokenService;

  beforeEach(async () => {
    const env = parseEnv({
      ...process.env,
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'unit-test-secret-at-least-32-characters-long',
    });
    const moduleRef = await Test.createTestingModule({
      providers: [TokenService, { provide: AppConfigService, useValue: new AppConfigService(env) }],
    }).compile();
    tokens = moduleRef.get(TokenService);
  });

  it('round-trips a user access token with role + permission matrix (TZ §6.3)', async () => {
    const token = tokens.signUserAccessToken({
      id: 'usr_1',
      roleKey: 'FLEET_MANAGER',
      permissions: { vehicles: 'FULL', hos: 'READ' } as never,
    });
    const claims = await tokens.verifyAccessToken(token);
    expect(claims).toMatchObject({
      id: 'usr_1',
      type: 'user',
      role: 'FLEET_MANAGER',
      permissions: { vehicles: 'FULL', hos: 'READ' },
    });
  });

  it('round-trips a driver access token with no role/permissions (TZ §6.1 — two subjects)', async () => {
    const token = tokens.signDriverAccessToken({ id: 'drv_1' });
    const claims = await tokens.verifyAccessToken(token);
    expect(claims).toMatchObject({ id: 'drv_1', type: 'driver' });
    expect(claims.role).toBeUndefined();
    expect(claims.permissions).toBeUndefined();
  });

  it('rejects a garbage token with TOKEN_INVALID', async () => {
    await expect(tokens.verifyAccessToken('not-a-jwt')).rejects.toThrow(AppException);
  });

  it('password-reset token carries userId + the bound password version', () => {
    const token = tokens.signPasswordResetToken('usr_1', 'hash-version-abc');
    expect(tokens.verifyPasswordResetToken(token)).toEqual({
      userId: 'usr_1',
      passwordVersion: 'hash-version-abc',
    });
  });

  /** MB-21 — refresh-token DB expiry must honour JWT_REFRESH_TTL / JWT_DRIVER_REFRESH_TTL. */
  describe('refreshTtlMs', () => {
    it('defaults to 30 days for user and 90 days for driver (unchanged behaviour)', () => {
      expect(tokens.refreshTtlMs('user')).toBe(30 * 24 * 60 * 60 * 1000);
      expect(tokens.refreshTtlMs('driver')).toBe(90 * 24 * 60 * 60 * 1000);
    });

    it('honours a custom JWT_REFRESH_TTL / JWT_DRIVER_REFRESH_TTL from env', async () => {
      const env = parseEnv({
        ...process.env,
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'unit-test-secret-at-least-32-characters-long',
        JWT_REFRESH_TTL: '7d',
        JWT_DRIVER_REFRESH_TTL: '45d',
      });
      const moduleRef = await Test.createTestingModule({
        providers: [TokenService, { provide: AppConfigService, useValue: new AppConfigService(env) }],
      }).compile();
      const customTokens = moduleRef.get(TokenService);
      expect(customTokens.refreshTtlMs('user')).toBe(7 * 24 * 60 * 60 * 1000);
      expect(customTokens.refreshTtlMs('driver')).toBe(45 * 24 * 60 * 60 * 1000);
    });

    it('throws on an invalid duration string', async () => {
      const env = parseEnv({
        ...process.env,
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'unit-test-secret-at-least-32-characters-long',
        JWT_REFRESH_TTL: 'not-a-duration',
      });
      const moduleRef = await Test.createTestingModule({
        providers: [TokenService, { provide: AppConfigService, useValue: new AppConfigService(env) }],
      }).compile();
      const badTokens = moduleRef.get(TokenService);
      expect(() => badTokens.refreshTtlMs('user')).toThrow();
    });
  });
});
