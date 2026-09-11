import { CreateApiKeyDto, UpdateApiKeyScopesDto } from './api-keys.dto';

describe('CreateApiKeyDto / UpdateApiKeyScopesDto (TZ §6.5 scope format)', () => {
  it('accepts "<permissionKey>:<READ|FULL>" scopes, case-insensitive on the level', () => {
    const result = CreateApiKeyDto.safeParse({ name: 'CI runner', scopes: ['reports:read', 'integrations:FULL'] });
    expect(result.success).toBe(true);
  });

  it('rejects a bare permission key with no level', () => {
    const result = CreateApiKeyDto.safeParse({ name: 'CI runner', scopes: ['reports'] });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown permission key', () => {
    const result = CreateApiKeyDto.safeParse({ name: 'CI runner', scopes: ['notAKey:read'] });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown level', () => {
    const result = CreateApiKeyDto.safeParse({ name: 'CI runner', scopes: ['reports:WRITE'] });
    expect(result.success).toBe(false);
  });

  it('UpdateApiKeyScopesDto applies the same scope format', () => {
    expect(UpdateApiKeyScopesDto.safeParse({ scopes: ['trips:full'] }).success).toBe(true);
    expect(UpdateApiKeyScopesDto.safeParse({ scopes: ['trips'] }).success).toBe(false);
  });
});
