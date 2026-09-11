import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '../../core/context/request-context';
import { AppException } from '../errors/app.exception';
import { JwtAuthGuard } from './jwt-auth.guard';

function ctxWithHeader(header?: string): ExecutionContext {
  const req: Record<string, unknown> = header ? { headers: { authorization: header } } : { headers: {} };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard — JWT vs API key routing (TZ §6.5, §11.7)', () => {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;

  beforeEach(() => {
    jest.spyOn(RequestContext, 'set').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('routes a JWT-shaped bearer token to TokenVerifier', async () => {
    const tokens = { verifyAccessToken: jest.fn().mockResolvedValue({ id: 'u1', type: 'user' }) };
    const apiKeys = { verify: jest.fn() };
    const guard = new JwtAuthGuard(reflector, tokens, apiKeys);

    const ok = await guard.canActivate(ctxWithHeader('Bearer eyJhbGciOi.header.sig'));

    expect(ok).toBe(true);
    expect(tokens.verifyAccessToken).toHaveBeenCalledWith('eyJhbGciOi.header.sig');
    expect(apiKeys.verify).not.toHaveBeenCalled();
  });

  it('routes an `obk_`-prefixed bearer token to ApiKeyVerifier', async () => {
    const tokens = { verifyAccessToken: jest.fn() };
    const apiKeys = { verify: jest.fn().mockResolvedValue({ id: 'key_1', type: 'api-key' }) };
    const guard = new JwtAuthGuard(reflector, tokens, apiKeys);

    const ok = await guard.canActivate(ctxWithHeader('Bearer obk_abc123'));

    expect(ok).toBe(true);
    expect(apiKeys.verify).toHaveBeenCalledWith('obk_abc123');
    expect(tokens.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects a missing bearer header with 401 UNAUTHORIZED', async () => {
    const guard = new JwtAuthGuard(reflector, { verifyAccessToken: jest.fn() }, { verify: jest.fn() });
    await expect(guard.canActivate(ctxWithHeader(undefined))).rejects.toBeInstanceOf(AppException);
  });
});
