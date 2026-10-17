import { describeLocation } from './location-description';
import { displayLocationTextOf, normalizeLocationText } from './location-display';

describe('normalizeLocationText (web display, §7.29 form)', () => {
  it.each([
    // §7.29 texts (computed by the backend / sent by the device) stay as they are.
    ['2mi SSE OH Riverside', '2mi SSE OH Riverside'],
    ['KY Florence', 'KY Florence'],
    ['10mi E IL Winthrop Harbor', '10mi E IL Winthrop Harbor'],
    ['4mi NNW KY Lexington-Fayette', '4mi NNW KY Lexington-Fayette'],
    // "N mi DIR of City, ST" / "City, ST" texts -> §7.29.
    ['2 mi E of Richmond, IN', '2mi E IN Richmond'],
    ['1 mi N of Florence, KY', '1mi N KY Florence'],
    ['3 mi W of Bowling Green, KY', '3mi W KY Bowling Green'],
    ['0.64 mi N of Florence, KY', '1mi N KY Florence'],
    ['0.4 mi N of Florence, KY', 'KY Florence'],
    ['Gary, IN', 'IN Gary'],
    ['Nashville, TN', 'TN Nashville'],
    ['St. Louis, MO', 'MO St. Louis'],
    ['Toronto, ON', 'ON Toronto'],
    // Unparseable / free text passes through unchanged.
    ['Teston, Vaughan, Canada', 'Teston, Vaughan, Canada'],
    ['Yard 4', 'Yard 4'],
    ['Iowa 80 Truckstop, Walcott, IA', 'Iowa 80 Truckstop, Walcott, IA'],
    ['Florence, Kentucky', 'Florence, Kentucky'],
    ['in the yard', 'in the yard'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeLocationText(input)).toBe(expected);
  });

  it('drops distance and direction for 0 mi and < 1 mi', () => {
    expect(normalizeLocationText('0mi E KY Florence')).toBe('KY Florence');
    expect(normalizeLocationText('<1mi E KY Florence')).toBe('KY Florence');
    expect(normalizeLocationText('< 1 mi NE of Florence, KY')).toBe('KY Florence');
    expect(normalizeLocationText('0 mi N of Gary, IN')).toBe('IN Gary');
  });

  it('accepts lower-case directions / states and a spaced "mi" in distance forms', () => {
    expect(normalizeLocationText('2mi sse oh Riverside')).toBe('2mi SSE OH Riverside');
    expect(normalizeLocationText('2 mi SSE OH Riverside')).toBe('2mi SSE OH Riverside');
    expect(normalizeLocationText('2 MI e of Richmond, in')).toBe('2mi E IN Richmond');
    expect(normalizeLocationText('5 mi. sw of Joliet, IL')).toBe('5mi SW IL Joliet');
  });

  it('keeps multi-word and hyphenated place names', () => {
    expect(normalizeLocationText('11mi NNW IN West Lafayette')).toBe('11mi NNW IN West Lafayette');
    expect(normalizeLocationText('4 mi S of Terre Haute, IN')).toBe('4mi S IN Terre Haute');
    expect(normalizeLocationText('6 mi NNW of Lexington-Fayette, KY')).toBe('6mi NNW KY Lexington-Fayette');
    expect(normalizeLocationText('Winston-Salem, NC')).toBe('NC Winston-Salem');
  });

  it('collapses extra spaces', () => {
    expect(normalizeLocationText('  2mi   SSE  OH   Riverside ')).toBe('2mi SSE OH Riverside');
    expect(normalizeLocationText(' 2  mi E  of  Richmond ,  IN ')).toBe('2mi E IN Richmond');
    expect(normalizeLocationText('Gary ,IN')).toBe('IN Gary');
  });

  it('passes through invalid directions, unknown states and > 99 mi unchanged', () => {
    expect(normalizeLocationText('2mi XX OH Riverside')).toBe('2mi XX OH Riverside');
    expect(normalizeLocationText('2 mi E of Richmond, ZZ')).toBe('2 mi E of Richmond, ZZ');
    expect(normalizeLocationText('120 mi N of Florence, KY')).toBe('120 mi N of Florence, KY');
    expect(normalizeLocationText('5 mi to go')).toBe('5 mi to go');
  });

  it('is idempotent', () => {
    for (const text of ['2 mi E of Richmond, IN', 'Gary, IN', '0.64 mi N of Florence, KY', '2mi sse oh Riverside', 'Teston, Vaughan, Canada']) {
      const once = normalizeLocationText(text);
      expect(normalizeLocationText(once)).toBe(once);
    }
  });

  it('caps the text at 60 characters (place name cut), like the computed text', () => {
    const out = normalizeLocationText(`12 mi E of ${'A'.repeat(70)}, OH`);
    expect(out).toBe(`12mi E OH ${'A'.repeat(50)}`);
    expect(out.length).toBe(60);
  });

  it('PC (reduced precision): distance in 10-mile steps, never more precise than the record', () => {
    expect(normalizeLocationText('12 mi E of Columbus, OH', { reducedPrecision: true })).toBe('10mi E OH Columbus');
    expect(normalizeLocationText('4mi S IN Terre Haute', { reducedPrecision: true })).toBe('IN Terre Haute');
    expect(normalizeLocationText('20mi SW OH Hilliard', { reducedPrecision: true })).toBe('20mi SW OH Hilliard');
    expect(normalizeLocationText('OH Hilliard', { reducedPrecision: true })).toBe('OH Hilliard');
  });

  it('null / undefined -> null, blank passes through', () => {
    expect(normalizeLocationText(null)).toBeNull();
    expect(normalizeLocationText(undefined)).toBeNull();
    expect(normalizeLocationText('  ')).toBe('  ');
  });
});

describe('displayLocationTextOf', () => {
  it('normalises the stored text and keeps the computed fallback', () => {
    expect(displayLocationTextOf({ locationName: '2 mi E of Richmond, IN' })).toBe('2mi E IN Richmond');
    expect(displayLocationTextOf({ locationName: null, latitude: 39.956522, longitude: -83.063508 })).toBe(
      describeLocation(39.956522, -83.063508),
    );
    expect(displayLocationTextOf(null)).toBeNull();
  });

  it('a 10-mile precision record (PC) is shown at 10-mile precision', () => {
    expect(displayLocationTextOf({ locationName: '12 mi E of Columbus, OH', locationPrecisionMi: 10 })).toBe('10mi E OH Columbus');
  });
});
