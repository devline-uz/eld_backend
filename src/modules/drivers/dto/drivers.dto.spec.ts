import { CreateDriverDto, DriverListQueryDto, UpdateDriverDto } from './drivers.dto';

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
});
