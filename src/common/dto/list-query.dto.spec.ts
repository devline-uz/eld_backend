import { escapeLike, ListQueryDto, MAX_LIST_PAGE, parseSort, toOffsetPage } from './list-query.dto';

describe('parseSort', () => {
  const allowed = ['name', 'createdAt'] as const;
  const fallback = { createdAt: 'desc' as const };

  it('returns the fallback when sort is undefined', () => {
    expect(parseSort(undefined, allowed, fallback)).toBe(fallback);
  });

  it('returns the fallback when the field is not in the allow-list', () => {
    expect(parseSort('unknownField:asc', allowed, fallback)).toBe(fallback);
  });

  it('parses "field:asc"', () => {
    expect(parseSort('name:asc', allowed, fallback)).toEqual({ name: 'asc' });
  });

  it('parses "field:desc"', () => {
    expect(parseSort('name:desc', allowed, fallback)).toEqual({ name: 'desc' });
  });

  it('defaults direction to asc when omitted or unrecognized', () => {
    expect(parseSort('name', allowed, fallback)).toEqual({ name: 'asc' });
    expect(parseSort('name:sideways', allowed, fallback)).toEqual({ name: 'asc' });
  });
});

describe('toOffsetPage', () => {
  it('computes totalPages from total/limit', () => {
    expect(toOffsetPage([{ id: 1 }], 45, 2, 20)).toEqual({
      items: [{ id: 1 }],
      page: 2,
      limit: 20,
      total: 45,
      totalPages: 3,
    });
  });

  it('never reports fewer than 1 total page, even for an empty result', () => {
    expect(toOffsetPage([], 0, 1, 25)).toEqual({ items: [], page: 1, limit: 25, total: 0, totalPages: 1 });
  });
});

describe('ListQueryDto page bound (BE-007)', () => {
  it('rejects a page past MAX_LIST_PAGE with a 422-able zod error instead of a 500 OFFSET', () => {
    expect(ListQueryDto.safeParse({ page: String(MAX_LIST_PAGE + 1) }).success).toBe(false);
    expect(ListQueryDto.parse({ page: String(MAX_LIST_PAGE) }).page).toBe(MAX_LIST_PAGE);
  });
});

describe('escapeLike (BE-014)', () => {
  it('escapes %, _ and backslash and leaves everything else alone', () => {
    expect(escapeLike('50%')).toBe('50\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('back\\slash')).toBe('back\\\\slash');
    expect(escapeLike('Unit 101-A')).toBe('Unit 101-A');
  });
});
