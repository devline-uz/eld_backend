import {
  buildOutputFileName,
  formatFileDate,
  formatFileSuffix,
  inclusiveDayCount,
  lastNameToken,
  licenseDigitSum,
  licenseLastTwoDigits,
} from './filename';

// 2026-09-11 13:04 EDT.
const CREATED = new Date('2026-09-11T17:04:05Z');
const EDT = -240;
const name = (lastName: string, cdlNumber: string, sequence = 1): string =>
  buildOutputFileName({ lastName, cdlNumber, sequence, createdAt: CREATED, timezoneOffsetMin: EDT });

describe('Appendix A 4.8.2.2 — output file name', () => {
  it('builds the 25-character standard name: last5 + lic2 + digitsum2 + MMDDYY + "-" + 9 chars', () => {
    // W8569238: last two digits 38; digit sum 8+5+6+9+2+3+8 = 41.
    const file = name('Smith', 'W8569238');
    expect(file).toBe('SMITH3841091126-000000000.csv');
    expect(file.replace(/\.csv$/, '')).toHaveLength(25);
  });

  it('pads a last name shorter than 5 letters with "_" (4.8.2.2(a), "Lee" -> "Lee__")', () => {
    expect(name('Ng', 'W8569238')).toBe('NG___3841091126-000000000.csv');
    expect(lastNameToken('Lee')).toBe('LEE__');
    expect(lastNameToken('')).toBe('_____');
  });

  it('truncates a long last name to its first 5 letters', () => {
    expect(lastNameToken('Vandersteen')).toBe('VANDE');
  });

  it("uses letters only: apostrophes, spaces, hyphens, digits and non-ASCII are dropped (O'Brien -> OBRIE)", () => {
    expect(lastNameToken("O'Brien")).toBe('OBRIE');
    expect(lastNameToken('de la Cruz')).toBe('DELAC');
    expect(lastNameToken('Smith-Jones')).toBe('SMITH');
    expect(lastNameToken('smith2nd')).toBe('SMITH');
    expect(lastNameToken("O'Brien-Núñez, Jr.")).toBe('OBRIE');
  });

  it('takes the last two DIGITS of the licence number and 0-pads a short one (4.8.2.2(b))', () => {
    expect(licenseLastTwoDigits('W8569238')).toBe('38');
    expect(licenseLastTwoDigits('ny 55-21 b')).toBe('21');
    expect(licenseLastTwoDigits('7')).toBe('07');
    expect(licenseLastTwoDigits('')).toBe('00');
    expect(licenseLastTwoDigits("--'")).toBe('00');
  });

  it('sums the licence digits, keeps the last two and 0-pads below 10 (4.8.2.2(c))', () => {
    expect(licenseDigitSum('W8569238')).toBe('41');
    expect(licenseDigitSum('7')).toBe('07');
    expect(licenseDigitSum('')).toBe('00');
    // 13 nines = 117 -> "17" (rule: 113 -> "13").
    expect(licenseDigitSum('9'.repeat(13))).toBe('17');
  });

  it('writes the creation date as MMDDYY in home-terminal time (4.8.2.2(d))', () => {
    expect(formatFileDate(CREATED, EDT)).toBe('091126');
    // 2026-09-12T02:30Z is still 09/11 in EDT.
    expect(formatFileDate(new Date('2026-09-12T02:30:00Z'), EDT)).toBe('091126');
    expect(formatFileDate(new Date('2013-02-05T12:00:00Z'))).toBe('020513');
  });

  it('keeps the default 000000000 suffix for the first file and makes the second distinct: 01 -> 02', () => {
    const first = name('Smith', 'W8569238', 1);
    const second = name('Smith', 'W8569238', 2);
    expect(first).toBe('SMITH3841091126-000000000.csv');
    expect(second).toBe('SMITH3841091126-000000001.csv');
    expect(first).not.toBe(second);
    expect(formatFileSuffix(12)).toBe('000000011');
    expect(() => formatFileSuffix(0)).toThrow(RangeError);
  });

  it('handles a short licence number in the full name', () => {
    expect(name('Ng', '7')).toBe('NG___0707091126-000000000.csv');
    expect(name('Smith', '')).toBe('SMITH0000091126-000000000.csv');
  });

  it('produces only A-Z, 0-9, "_" and "-" before .csv, always 25 characters', () => {
    for (const [last, cdl] of [
      ["  Ödön O'Neill-Smith ", 'ny 55-21 b'],
      ['X', ''],
      ['Vandersteen', 'D000368210361'],
    ]) {
      const file = name(last, cdl, 3);
      expect(file).toMatch(/^[A-Z_]{5}[0-9]{4}[0-9]{6}-[0-9A-Z]{9}\.csv$/);
    }
    expect(name("  Ödön O'Neill-Smith ", 'ny 55-21 b', 3)).toBe('DNONE2113091126-000000002.csv');
  });

  it('takes the date part from createdAt in home-terminal time, not from the wall clock', () => {
    // 22:30 EDT on 2026-09-11 is already 2026-09-12 in UTC.
    const late = new Date('2026-09-12T02:30:00Z');
    expect(
      buildOutputFileName({ lastName: 'Smith', cdlNumber: 'W8569238', sequence: 1, createdAt: late, timezoneOffsetMin: EDT }),
    ).toBe('SMITH3841091126-000000000.csv');
    expect(buildOutputFileName({ lastName: 'Smith', cdlNumber: 'W8569238', sequence: 1, createdAt: late })).toBe(
      'SMITH3841091226-000000000.csv',
    );
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
