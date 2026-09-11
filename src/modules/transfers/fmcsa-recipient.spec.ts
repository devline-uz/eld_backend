import { isFmcsaRecipient } from './fmcsa-recipient';

describe('tz.md §10.4 — email transfer recipient must be fmcsa.dot.gov', () => {
  it.each([
    'eldsubmissions@fmcsa.dot.gov',
    'ELDSubmissions@FMCSA.DOT.GOV',
    'test@eld.fmcsa.dot.gov',
    '  inspector@fmcsa.dot.gov  ',
  ])('accepts %s', (address) => {
    expect(isFmcsaRecipient(address)).toBe(true);
  });

  it.each([
    'someone@gmail.com',
    'someone@dot.gov',
    'someone@notfmcsa.dot.gov',
    'someone@fmcsa.dot.gov.evil.com',
    'someone@fmcsa.dot.gov.uk',
    'someone@fmcsadotgov',
    'fmcsa.dot.gov',
    'a@fmcsa.dot.gov,b@gmail.com',
    'a@fmcsa.dot.gov;b@gmail.com',
    'a@fmcsa.dot.gov b@gmail.com',
    '@fmcsa.dot.gov',
    '',
  ])('rejects %s', (address) => {
    expect(isFmcsaRecipient(address)).toBe(false);
  });

  it('rejects a null/undefined recipient without throwing', () => {
    expect(isFmcsaRecipient(undefined as unknown as string)).toBe(false);
  });

  it('is not fooled by a display name wrapper', () => {
    expect(isFmcsaRecipient('FMCSA <eldsubmissions@fmcsa.dot.gov>')).toBe(false);
  });
});
