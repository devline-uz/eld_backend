/**
 * §395 Appendix A (> tz.md §10.1) — `eldIdentifier` / `eldRegistrationId` are EXACTLY
 * 4 characters from `A-Z` / `0-9`. Length alone is insufficient: a 4-char value with a
 * comma, `#`, space or lowercase letter still invalidates the generated output file and
 * the 4.8.2.2 file name.
 */
import { ErodsIdentifierSchema, UpdateCarrierDto } from './carrier.dto';

describe('ErodsIdentifierSchema (§395 Appendix A)', () => {
  it.each(['OBK1', 'ABCD', '1234', 'A1B2'])('accepts the 4-char alphanumeric value %s', (v) => {
    expect(ErodsIdentifierSchema.parse(v)).toBe(v);
  });

  it.each([
    ['too short', 'OBK'],
    ['too long (the old TEST01 bug)', 'TEST01'],
    ['6-char ONEB01', 'ONEB01'],
    ['empty', ''],
    ['hash', '#OB1'],
    ['comma — would break the CSV segment', 'OB,1'],
    ['space', 'OB 1'],
    ['dash', 'OB-1'],
    ['non-ascii', 'OBKÇ'],
  ])('rejects %s', (_label, value) => {
    expect(ErodsIdentifierSchema.safeParse(value).success).toBe(false);
  });

  it('normalises case and surrounding whitespace instead of persisting an illegal value', () => {
    expect(ErodsIdentifierSchema.parse(' obk1 ')).toBe('OBK1');
  });
});

describe('UpdateCarrierDto eRODS fields', () => {
  it('rejects a 4-char eldIdentifier containing an illegal character', () => {
    expect(UpdateCarrierDto.safeParse({ eldIdentifier: 'OB#1' }).success).toBe(false);
  });

  it('rejects a short eldRegistrationId', () => {
    expect(UpdateCarrierDto.safeParse({ eldRegistrationId: 'AB' }).success).toBe(false);
  });

  it('upper-cases both identifiers on the way in', () => {
    const parsed = UpdateCarrierDto.parse({ eldIdentifier: 'obk1', eldRegistrationId: 'ab12' });
    expect(parsed).toEqual({ eldIdentifier: 'OBK1', eldRegistrationId: 'AB12' });
  });

  it('defaults nothing — erodsMode is only changed when explicitly sent (TEST stays the DB default)', () => {
    expect(UpdateCarrierDto.parse({ name: 'Acme' })).toEqual({ name: 'Acme' });
    expect(UpdateCarrierDto.safeParse({ erodsMode: 'PRODUCTION' }).success).toBe(true);
    expect(UpdateCarrierDto.safeParse({ erodsMode: 'LIVE' }).success).toBe(false);
  });
});
