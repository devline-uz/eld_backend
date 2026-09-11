import {
  buildOutputFileName,
  formatDayCount,
  formatFileSequence,
  inclusiveDayCount,
  sanitizeNameToken,
} from './filename';

describe('Appendix A 4.8.2.2 — output file name', () => {
  it('builds the canonical example from tz.md §10.2 (SMITH38018.csv)', () => {
    expect(
      buildOutputFileName({ lastName: 'Smith', cdlNumber: 'W8569238', sequence: 1, dayCount: 8 }),
    ).toBe('SMITH38018.csv');
  });

  it('does NOT pad a last name shorter than 5 characters', () => {
    expect(buildOutputFileName({ lastName: 'Ng', cdlNumber: 'W8569238', sequence: 1, dayCount: 8 })).toBe(
      'NG38018.csv',
    );
    expect(buildOutputFileName({ lastName: 'Li', cdlNumber: 'A1', sequence: 2, dayCount: 1 })).toBe('LIA1021.csv');
  });

  it('truncates a long last name to the first 5 characters', () => {
    expect(
      buildOutputFileName({ lastName: 'Vandersteen', cdlNumber: 'K9900412', sequence: 1, dayCount: 8 }),
    ).toBe('VANDE12018.csv');
  });

  it("drops apostrophes, spaces and hyphens instead of replacing them (O'Brien -> OBRIE)", () => {
    expect(
      buildOutputFileName({ lastName: "O'Brien", cdlNumber: 'D4471193', sequence: 1, dayCount: 8 }),
    ).toBe('OBRIE93018.csv');
    expect(
      buildOutputFileName({ lastName: 'de la Cruz', cdlNumber: 'D4471193', sequence: 1, dayCount: 8 }),
    ).toBe('DELAC93018.csv');
    expect(
      buildOutputFileName({ lastName: 'Smith-Jones', cdlNumber: 'D4471193', sequence: 1, dayCount: 8 }),
    ).toBe('SMITH93018.csv');
  });

  it('uppercases everything and keeps digits that appear in a name', () => {
    expect(buildOutputFileName({ lastName: 'smith2nd', cdlNumber: 'w856-9238', sequence: 1, dayCount: 8 })).toBe(
      'SMITH38018.csv',
    );
  });

  it('increments the 2-digit file sequence 01 -> 02 for the second file of the same day', () => {
    const first = buildOutputFileName({ lastName: 'Smith', cdlNumber: 'W8569238', sequence: 1, dayCount: 8 });
    const second = buildOutputFileName({ lastName: 'Smith', cdlNumber: 'W8569238', sequence: 2, dayCount: 8 });
    expect(first).toBe('SMITH38018.csv');
    expect(second).toBe('SMITH38028.csv');
    expect(buildOutputFileName({ lastName: 'Smith', cdlNumber: 'W8569238', sequence: 12, dayCount: 8 })).toBe(
      'SMITH38128.csv',
    );
  });

  it('handles a CDL number shorter than 2 characters without padding', () => {
    expect(buildOutputFileName({ lastName: 'Smith', cdlNumber: '7', sequence: 1, dayCount: 8 })).toBe(
      'SMITH7018.csv',
    );
    expect(buildOutputFileName({ lastName: 'Smith', cdlNumber: '', sequence: 1, dayCount: 8 })).toBe('SMITH018.csv');
    expect(buildOutputFileName({ lastName: 'Smith', cdlNumber: "--'", sequence: 1, dayCount: 8 })).toBe(
      'SMITH018.csv',
    );
  });

  it('produces only A-Z, 0-9 and the .csv suffix', () => {
    const name = buildOutputFileName({
      lastName: "  Ödön O'Neill-Smith ",
      cdlNumber: 'ny 55-21 b',
      sequence: 3,
      dayCount: 8,
    });
    expect(name).toMatch(/^[A-Z0-9]+\.csv$/);
    expect(name).toBe('DNONE1B038.csv');
  });

  describe('sanitizeNameToken', () => {
    it('is empty for a value with no alphanumerics', () => {
      expect(sanitizeNameToken("-' .")).toBe('');
    });
  });

  describe('formatFileSequence', () => {
    it('pads to 2 digits', () => {
      expect(formatFileSequence(1)).toBe('01');
      expect(formatFileSequence(9)).toBe('09');
      expect(formatFileSequence(10)).toBe('10');
      expect(formatFileSequence(99)).toBe('99');
    });

    it('wraps at 100 because Appendix A allows exactly 2 digits', () => {
      expect(formatFileSequence(100)).toBe('00');
      expect(formatFileSequence(101)).toBe('01');
    });

    it('rejects a sequence below 1', () => {
      expect(() => formatFileSequence(0)).toThrow(RangeError);
      expect(() => formatFileSequence(-1)).toThrow(RangeError);
    });
  });

  describe('formatDayCount', () => {
    it('accepts 1..9', () => {
      expect(formatDayCount(1)).toBe('1');
      expect(formatDayCount(8)).toBe('8');
      expect(formatDayCount(9)).toBe('9');
    });

    it('rejects a count that does not fit one digit', () => {
      expect(() => formatDayCount(10)).toThrow(RangeError);
      expect(() => formatDayCount(0)).toThrow(RangeError);
    });
  });

  describe('inclusiveDayCount', () => {
    it('counts both endpoints', () => {
      expect(inclusiveDayCount(new Date('2026-09-04T00:00:00Z'), new Date('2026-09-11T00:00:00Z'))).toBe(8);
      expect(inclusiveDayCount(new Date('2026-09-11T00:00:00Z'), new Date('2026-09-11T00:00:00Z'))).toBe(1);
    });

    it('is unaffected by the time of day', () => {
      expect(inclusiveDayCount(new Date('2026-09-04T23:59:59Z'), new Date('2026-09-11T00:00:01Z'))).toBe(8);
    });
  });
});
