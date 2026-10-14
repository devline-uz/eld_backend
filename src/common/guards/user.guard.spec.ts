import type { ExecutionContext } from '@nestjs/common';
import { RequestContext, type ContextUser } from '../../core/context/request-context';
import { UserGuard } from './user.guard';

function run(user: ContextUser | undefined): boolean {
  return RequestContext.run({ requestId: 'r', traceId: 't', startedAt: 0, user }, () => new UserGuard().canActivate({} as ExecutionContext));
}

describe('UserGuard (CODE-079 — /me/* is for back-office users)', () => {
  it('lets a back-office user through', () => {
    expect(run({ id: 'u1', type: 'user' })).toBe(true);
  });

  it.each(['driver', 'api-key'] as const)('refuses a %s token with 403 USER_CONTEXT_REQUIRED', (type) => {
    expect(() => run({ id: 'x1', type })).toThrow(expect.objectContaining({ code: 'USER_CONTEXT_REQUIRED', status: 403 }) as Error);
  });

  it('401 without a principal', () => {
    expect(() => run(undefined)).toThrow(expect.objectContaining({ status: 401 }) as Error);
  });
});
