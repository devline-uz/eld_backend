/**
 * §395 Appendix A (> tz.md §10.1) — `eldIdentifier` is EXACTLY 6 characters (7.15) and
 * `eldRegistrationId` EXACTLY 4 (7.17), both from `A-Z` / `0-9` (bugs.md B-138). Length alone
 * is insufficient: a value with a comma, `#`, space or lowercase letter still invalidates the
 * generated output file.
 */
import { EldIdentifierSchema, EldRegistrationIdSchema, UpdateCarrierDto } from './carrier.dto';

describe('EldIdentifierSchema (§395 Appendix A 7.15)', () => {
  it.each(['OBK001', '1001ZE', 'GAM112', '02P3P1'])('accepts the 6-char alphanumeric value %s', (v) => {
    expect(EldIdentifierSchema.parse(v)).toBe(v);
  });

  it.each([
    ['the old 4-char OBK1 (B-138)', 'OBK1'],
    ['too short', 'OBK01'],
    ['too long', 'OBK0001'],
    ['empty', ''],
    ['hash', '#OBK01'],
    ['comma — would break the CSV segment', 'OB,001'],
    ['space', 'OB 001'],
    ['dash', 'OB-001'],
    ['non-ascii', 'OBK00Ç'],
  ])('rejects %s', (_label, value) => {
    expect(EldIdentifierSchema.safeParse(value).success).toBe(false);
  });

  it('normalises case and surrounding whitespace instead of persisting an illegal value', () => {
    expect(EldIdentifierSchema.parse(' obk001 ')).toBe('OBK001');
  });
});

describe('EldRegistrationIdSchema (§395 Appendix A 7.17)', () => {
  it.each(['ZA10', 'QA0C', 'FAZ2', 'OBK1'])('accepts the 4-char alphanumeric value %s', (v) => {
    expect(EldRegistrationIdSchema.parse(v)).toBe(v);
  });

  it.each([
    ['too short', 'OBK'],
    ['6 chars (an identifier, not a registration id)', 'TEST01'],
    ['empty', ''],
    ['hash', '#OB1'],
    ['comma', 'OB,1'],
    ['space', 'OB 1'],
  ])('rejects %s', (_label, value) => {
    expect(EldRegistrationIdSchema.safeParse(value).success).toBe(false);
  });
});

describe('UpdateCarrierDto eRODS fields', () => {
  it('rejects a 6-char eldIdentifier containing an illegal character', () => {
    expect(UpdateCarrierDto.safeParse({ eldIdentifier: 'OB#001' }).success).toBe(false);
  });

  it('rejects a 4-char eldIdentifier and a 6-char eldRegistrationId (lengths are not interchangeable)', () => {
    expect(UpdateCarrierDto.safeParse({ eldIdentifier: 'OBK1' }).success).toBe(false);
    expect(UpdateCarrierDto.safeParse({ eldRegistrationId: 'OBK001' }).success).toBe(false);
  });

  it('rejects a short eldRegistrationId', () => {
    expect(UpdateCarrierDto.safeParse({ eldRegistrationId: 'AB' }).success).toBe(false);
  });

  it('upper-cases both identifiers on the way in', () => {
    const parsed = UpdateCarrierDto.parse({ eldIdentifier: 'obk001', eldRegistrationId: 'ab12' });
    expect(parsed).toEqual({ eldIdentifier: 'OBK001', eldRegistrationId: 'AB12' });
  });

  it('defaults nothing — erodsMode is only changed when explicitly sent (TEST stays the DB default)', () => {
    expect(UpdateCarrierDto.parse({ name: 'Acme' })).toEqual({ name: 'Acme' });
    expect(UpdateCarrierDto.safeParse({ erodsMode: 'PRODUCTION' }).success).toBe(true);
    expect(UpdateCarrierDto.safeParse({ erodsMode: 'LIVE' }).success).toBe(false);
  });
});
