import { ilike, like, matchesStringFilter } from '../../../test/helpers/fake-like-filters';
import {
  containsInsensitive,
  endsWithInsensitive,
  equalsInsensitive,
  escapeLike,
  inInsensitive,
  startsWithInsensitive,
} from './insensitive';
import { emailEqualsInsensitive } from '../email/email-lookup';

describe('escapeLike', () => {
  it.each([
    ['50%', '50\\%'],
    ['a_b', 'a\\_b'],
    ['back\\slash', 'back\\\\slash'],
    ['\\%', '\\\\\\%'],
    ['%_\\', '\\%\\_\\\\'],
    ['Unit 101-A', 'Unit 101-A'],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(escapeLike(input)).toBe(expected);
  });

  it.each(['%', '_', '\\', 'a%b_c\\d', '\\%', '\\_', '%%', '__', 'trailing\\'])('round-trips %j as a literal LIKE pattern', (value) => {
    expect(like(value, escapeLike(value))).toBe(true);
    expect(ilike(value.toUpperCase(), escapeLike(value.toLowerCase()))).toBe(true);
  });
});

describe('insensitive filter helpers', () => {
  it('build the Prisma filter shapes with escaped values and do not trim', () => {
    expect(equalsInsensitive(' A_b% ')).toEqual({ equals: ' A\\_b\\% ', mode: 'insensitive' });
    expect(containsInsensitive('5%')).toEqual({ contains: '5\\%', mode: 'insensitive' });
    expect(startsWithInsensitive('V_')).toEqual({ startsWith: 'V\\_', mode: 'insensitive' });
    expect(endsWithInsensitive('\\')).toEqual({ endsWith: '\\\\', mode: 'insensitive' });
  });

  it('inInsensitive leaves values unescaped (Prisma renders LOWER(col) IN (...), not LIKE)', () => {
    expect(inInsensitive(['A_1', '5%'])).toEqual({ in: ['A_1', '5%'], mode: 'insensitive' });
    expect(matchesStringFilter('a_1', inInsensitive(['A_1']))).toBe(true);
    expect(matchesStringFilter('AB1', inInsensitive(['A_1']))).toBe(false);
  });

  describe('equalsInsensitive is a literal case-insensitive equality', () => {
    it.each([
      ['ABC', 'abc', true],
      ['A%C', 'a%c', true],
      ['ABC', 'a%c', false],
      ['A_C', 'a_c', true],
      ['ABC', 'a_c', false],
      ['A\\C', 'a\\c', true],
      ['AC', 'a\\c', false],
      ['anything', '%', false],
      ['%', '%', true],
      ['X', '_', false],
    ])('%j vs %j -> %s', (stored, typed, expected) => {
      expect(matchesStringFilter(stored, equalsInsensitive(typed))).toBe(expected);
      // and the unescaped Prisma filter really was a pattern match for the wildcard cases
      if (!expected && /[%_]/.test(typed)) expect(matchesStringFilter(stored, { equals: typed, mode: 'insensitive' })).toBe(true);
    });
  });

  describe('contains/startsWith/endsWith are literal', () => {
    const rows = ['Unit 50% off', 'Unit 500', 'A_B', 'AXB', 'C:\\dir', 'C:dir'];
    const hits = (filter: unknown) => rows.filter((r) => matchesStringFilter(r, filter));

    it('contains', () => {
      expect(hits(containsInsensitive('%'))).toEqual(['Unit 50% off']);
      expect(hits(containsInsensitive('a_b'))).toEqual(['A_B']);
      expect(hits(containsInsensitive('\\'))).toEqual(['C:\\dir']);
      expect(hits(containsInsensitive('unit'))).toEqual(['Unit 50% off', 'Unit 500']);
      expect(hits({ contains: '%', mode: 'insensitive' })).toEqual(rows); // the bug being fixed
    });

    it('startsWith / endsWith', () => {
      expect(hits(startsWithInsensitive('_'))).toEqual([]);
      expect(hits(startsWithInsensitive('a_'))).toEqual(['A_B']);
      expect(hits(endsWithInsensitive('% OFF'))).toEqual(['Unit 50% off']);
      expect(hits(endsWithInsensitive('_b'))).toEqual(['A_B']);
    });
  });

  it('emailEqualsInsensitive keeps its behaviour (trim + lower-case + literal)', () => {
    expect(emailEqualsInsensitive('  John_Doe@X.com ')).toEqual({ equals: 'john\\_doe@x.com', mode: 'insensitive' });
    expect(matchesStringFilter('John_Doe@x.com', emailEqualsInsensitive('john_doe@X.COM'))).toBe(true);
    expect(matchesStringFilter('johnXdoe@x.com', emailEqualsInsensitive('john_doe@x.com'))).toBe(false);
    expect(matchesStringFilter('a@b.co', emailEqualsInsensitive('%'))).toBe(false);
  });
});
