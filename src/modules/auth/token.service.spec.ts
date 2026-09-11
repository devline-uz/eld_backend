import { Test } from '@nestjs/testing';
import { AppConfigService } from '../../core/config/config.service';
import { parseEnv } from '../../core/config/env.schema';
import { AppException } from '../../common/errors/app.exception';
import { TokenService } from './token.service';

/** TZ §6.3 — token contents; §6.2 pending-2FA token round-trip. */
describe('TokenService', () => {
  let tokens: TokenService;

  beforeEach(async () => {
    const env = parseEnv({
      ...process.env,
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'unit-test-secret-at-least-32-characters-long',
      JWT_PENDING_2FA_TTL: '1s',
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
      twoFactorEnabled: false,
    });
    const claims = await tokens.verifyAccessToken(token);
    expect(claims).toMatchObject({
      id: 'usr_1',
      type: 'user',
      role: 'FLEET_MANAGER',
      permissions: { vehicles: 'FULL', hos: 'READ' },
      twoFactorEnabled: false,
    });
  });

  it('round-trips a driver access token with no role/permissions (TZ §6.1 — two subjects)', async () => {
    const token = tokens.signDriverAccessToken({ id: 'drv_1' });
    const claims = await tokens.verifyAccessToken(token);
    expect(claims).toMatchObject({ id: 'drv_1', type: 'driver' });
    expect(claims.role).toBeUndefined();
    expect(claims.permissions).toBeUndefined();
  });

  it('a pending-2FA token is not a valid access token', async () => {
    const pending = tokens.signPendingTwoFactorToken('usr_1');
    await expect(tokens.verifyAccessToken(pending)).rejects.toThrow(AppException);
  });

  it('an access token cannot be used as a pending-2FA token', () => {
    const access = tokens.signUserAccessToken({
      id: 'usr_1',
      roleKey: 'ADMIN',
      permissions: {} as never,
      twoFactorEnabled: true,
    });
    expect(() => tokens.verifyPendingTwoFactorToken(access)).toThrow(AppException);
  });

  it('verifyPendingTwoFactorToken recovers the userId', () => {
    const pending = tokens.signPendingTwoFactorToken('usr_42');
    expect(tokens.verifyPendingTwoFactorToken(pending)).toBe('usr_42');
  });

  it('rejects an expired token with TOKEN_EXPIRED', async () => {
    const pending = tokens.signPendingTwoFactorToken('usr_1');
    await new Promise((r) => setTimeout(r, 1100));
    expect(() => tokens.verifyPendingTwoFactorToken(pending)).toThrow(/expired/i);
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
});
