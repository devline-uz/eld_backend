import { emailEqualsInsensitive, normalizeEmail } from './email-lookup';

describe('email-lookup', () => {
  it('normalizeEmail trims and lower-cases', () => {
    expect(normalizeEmail('  John.Smith@Example.COM \t')).toBe('john.smith@example.com');
  });

  it('emailEqualsInsensitive normalizes and queries case-insensitively', () => {
    expect(emailEqualsInsensitive('  John@X.com ')).toEqual({ equals: 'john@x.com', mode: 'insensitive' });
  });

  it('emailEqualsInsensitive escapes LIKE metacharacters so `_` / `%` are literal', () => {
    expect(emailEqualsInsensitive('J_hn%@x.com')).toEqual({ equals: 'j\\_hn\\%@x.com', mode: 'insensitive' });
    expect(emailEqualsInsensitive('a\\b@x.com').equals).toBe('a\\\\b@x.com');
  });
});
