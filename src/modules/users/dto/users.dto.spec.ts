import { CreateUserDto, MY_PROFILE_PHONE_MESSAGE, UpdateMyProfileDto, UpdateUserDto } from './users.dto';

describe('UpdateMyProfileDto.phone (PATCH /me/profile — E.164)', () => {
  it.each(['', '+998901234567', '+12025550123'])('accepts %j', (phone) => {
    const result = UpdateMyProfileDto.safeParse({ phone });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.phone).toBe(phone);
  });

  it('accepts a body with the phone omitted', () => {
    const result = UpdateMyProfileDto.safeParse({ firstName: 'Sarah' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.phone).toBeUndefined();
  });

  it.each(['+999123', '+99890123456789', 'abc', '998901234567'])('rejects %j with the E.164 message', (phone) => {
    const result = UpdateMyProfileDto.safeParse({ phone });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([expect.objectContaining({ path: ['phone'], message: MY_PROFILE_PHONE_MESSAGE })]);
    }
  });
});

const createBase = {
  email: 'new.user@universal-logistics.example',
  firstName: 'New',
  lastName: 'User',
  roleId: '3f1c2b9e-8a4d-4c6e-9b7a-1d2e3f4a5b6c',
};

describe.each([
  ['CreateUserDto (POST /users)', CreateUserDto, createBase],
  ['UpdateUserDto (PATCH /users/:id)', UpdateUserDto, { firstName: 'Sarah' }],
] as const)('%s phone — E.164', (_name, schema, base) => {
  it.each(['', '+998901234567', '+12025550123'])('accepts %j', (phone) => {
    const result = schema.safeParse({ ...base, phone });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.phone).toBe(phone);
  });

  it('accepts a body with the phone omitted', () => {
    const result = schema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.phone).toBeUndefined();
  });

  it.each(['+999123', '+99890123456789', 'abc', '998901234567'])('rejects %j with the E.164 message', (phone) => {
    const result = schema.safeParse({ ...base, phone });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([expect.objectContaining({ path: ['phone'], message: MY_PROFILE_PHONE_MESSAGE })]);
    }
  });
});
