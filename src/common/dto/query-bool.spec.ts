import { QueryBoolean } from './query-bool';

describe('QueryBoolean (CODE-036)', () => {
  it.each([
    ['true', true],
    ['1', true],
    [true, true],
    ['false', false],
    ['0', false],
    [false, false],
  ])('parses %p as %p', (input, expected) => {
    expect(QueryBoolean.parse(input)).toBe(expected);
  });

  it.each(['yes', '', 'FALSE ', 'null'])('rejects %p', (input) => {
    expect(QueryBoolean.safeParse(input).success).toBe(false);
  });

  it('keeps optional/default behaviour', () => {
    expect(QueryBoolean.optional().parse(undefined)).toBeUndefined();
    expect(QueryBoolean.default(false).parse(undefined)).toBe(false);
  });
});
