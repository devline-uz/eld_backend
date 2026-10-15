import { CreateDriverDto, DriverListQueryDto, ImportDriversDto, InvokeAdverseDrivingDto, UpdateDriverDto } from './drivers.dto';

const base = { username: 'jsmith', firstName: 'John', lastName: 'Smith', cdlNumber: 'D1234567', cdlState: 'OH' };

describe('CreateDriverDto / UpdateDriverDto (BE-007 / BE-015 / BE-017)', () => {
  it('trims names / username / licence number and rejects whitespace-only names', () => {
    const parsed = CreateDriverDto.parse({ ...base, username: ' jsmith ', firstName: ' John ', lastName: ' Smith ', cdlNumber: ' D1 ' });
    expect([parsed.username, parsed.firstName, parsed.lastName, parsed.cdlNumber]).toEqual(['jsmith', 'John', 'Smith', 'D1']);
    expect(CreateDriverDto.safeParse({ ...base, firstName: '   ' }).success).toBe(false);
    expect(CreateDriverDto.safeParse({ ...base, lastName: '\t' }).success).toBe(false);
    expect(UpdateDriverDto.safeParse({ firstName: '  ' }).success).toBe(false);
  });

  it('cdlState: upper-cases a US state / CA province code and rejects anything else', () => {
    expect(CreateDriverDto.parse({ ...base, cdlState: 'tx' }).cdlState).toBe('TX');
    expect(CreateDriverDto.parse({ ...base, cdlState: 'QC' }).cdlState).toBe('QC');
    expect(CreateDriverDto.safeParse({ ...base, cdlState: 'ZZZZZ' }).success).toBe(false);
    expect(UpdateDriverDto.safeParse({ cdlState: 'XX' }).success).toBe(false);
  });

  it('caps the list page', () => {
    expect(DriverListQueryDto.safeParse({ page: '99999999999' }).success).toBe(false);
    expect(DriverListQueryDto.parse({ page: '10000' }).page).toBe(10_000);
  });

  it('email: trimmed before the format check, capped at 254; password re-auth fields are optional', () => {
    expect(CreateDriverDto.parse({ ...base, email: '  a@b.co ' }).email).toBe('a@b.co');
    expect(UpdateDriverDto.parse({ email: ' a@b.co' }).email).toBe('a@b.co');
    expect(UpdateDriverDto.safeParse({ email: `${'a'.repeat(250)}@b.co` }).success).toBe(false);
    expect(UpdateDriverDto.safeParse({ email: 'not-an-email' }).success).toBe(false);
    expect(UpdateDriverDto.parse({ email: 'a@b.co', currentPassword: 'pw' }).currentPassword).toBe('pw');
    // Clearing: '' / whitespace / null are accepted; omitted stays undefined (= unchanged).
    expect(UpdateDriverDto.parse({ email: '' }).email).toBe('');
    expect(UpdateDriverDto.parse({ email: '   ' }).email).toBe('');
    expect(UpdateDriverDto.parse({ email: null }).email).toBeNull();
    expect(UpdateDriverDto.parse({}).email).toBeUndefined();
  });

  it('create / import: blank email (empty, whitespace, null) is accepted as "no email"; real values still validated', () => {
    expect(CreateDriverDto.parse({ ...base, email: '' }).email).toBe('');
    expect(CreateDriverDto.parse({ ...base, email: '   ' }).email).toBe('');
    expect(CreateDriverDto.parse({ ...base, email: null }).email).toBeNull();
    expect(CreateDriverDto.parse(base).email).toBeUndefined();
    expect(CreateDriverDto.safeParse({ ...base, email: 'not-an-email' }).success).toBe(false);
    expect(CreateDriverDto.safeParse({ ...base, email: `${'a'.repeat(250)}@b.co` }).success).toBe(false);
    // A blank CSV email cell must not 422 the whole import body.
    const rows = ImportDriversDto.parse({ drivers: [{ ...base, email: '' }, { ...base, username: 'jdoe', email: ' J@B.co ' }] });
    expect(rows.drivers.map((r) => r.email)).toEqual(['', 'J@B.co']);
  });
});

describe('InvokeAdverseDrivingDto — BE-10', () => {
  it('refuses an impossible calendar date instead of rolling it over (422, not 500)', () => {
    expect(InvokeAdverseDrivingDto.safeParse({ date: '2025-13-01', annotation: 'Snow storm on I-80' }).success).toBe(false);
    expect(InvokeAdverseDrivingDto.safeParse({ date: '2026-02-30', annotation: 'Snow storm on I-80' }).success).toBe(false);
    expect(InvokeAdverseDrivingDto.safeParse({ date: '2026-02-28', annotation: 'Snow storm on I-80' }).success).toBe(true);
  });
});

describe('ImportDriversDto — BE-09', () => {
  it('applies no create-time defaults to an import row (an UPDATE row must keep omitted settings)', () => {
    const [row] = ImportDriversDto.parse({ drivers: [base] }).drivers;
    expect(row.homeTerminalTimezone).toBeUndefined();
    expect(row.splitSleeperEnabled).toBeUndefined();
    expect(row.allowPersonalConveyance).toBeUndefined();
  });
});
