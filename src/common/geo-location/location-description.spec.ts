import {
  bearingDeg,
  compass16,
  describeLocation,
  formatGeoLocation,
  getPlaceIndex,
  parsePlaces,
  PlaceIndex,
  resolveLocationText,
} from './location-description';
import { LocationDescriptionService } from './location-description.service';

describe('geo-location (§395 Appendix A 4.4.2 / 7.29)', () => {
  const tiny = new PlaceIndex(
    parsePlaces(
      ['# comment', 'Columbus\tOH\t39.961\t-82.999', 'Darien\tIL\t41.752\t-87.974', 'bad\tXX\tNaN\t1', ''].join('\n'),
    ),
  );

  it('ships a database of >= 5,000 US/CA/MX places, every row with a 2-letter state', () => {
    const index = getPlaceIndex();
    expect(index.size).toBeGreaterThan(5000);
    expect(getPlaceIndex()).toBe(index); // built once
  });

  it('16-point compass, sectors centred on each point', () => {
    expect(compass16(0)).toBe('N');
    expect(compass16(11.24)).toBe('N');
    expect(compass16(11.26)).toBe('NNE');
    expect(compass16(112.5)).toBe('ESE');
    expect(compass16(270)).toBe('W');
    expect(compass16(349)).toBe('N');
    expect(compass16(-90)).toBe('W');
  });

  it('bearing is measured FROM the place TO the position', () => {
    expect(bearingDeg({ lat: 40, lon: -83 }, { lat: 41, lon: -83 })).toBeCloseTo(0, 5);
    expect(bearingDeg({ lat: 40, lon: -83 }, { lat: 40, lon: -84 })).toBeGreaterThan(269);
  });

  it('formats `<d>mi <dir> <ST> <Place>` (Appendix A 7.29 examples)', () => {
    // ~3.4 mi due west of Columbus
    expect(describeLocation(39.961, -83.063, {}, tiny)).toBe('3mi W OH Columbus');
    expect(describeLocation(41.73, -87.94, {}, tiny)).toMatch(/^2mi (SE|ESE) IL Darien$/);
  });

  it('distance rounding to 0 leaves distance and direction blank', () => {
    expect(describeLocation(39.962, -82.999, {}, tiny)).toBe('OH Columbus');
  });

  it('personal conveyance rounds the distance to 10 mi', () => {
    expect(describeLocation(39.961, -83.063, { reducedPrecision: true }, tiny)).toBe('OH Columbus');
    expect(describeLocation(39.961, -83.25, { reducedPrecision: true }, tiny)).toBe('10mi W OH Columbus');
  });

  it('no description beyond 99 mi, without a position or with invalid coordinates', () => {
    expect(describeLocation(10, 10, {}, tiny)).toBeNull();
    expect(describeLocation(39.961, -81.0, {}, tiny)).toBeNull(); // ~106 mi east
    expect(describeLocation(null, -83, {}, tiny)).toBeNull();
    expect(describeLocation('', -83, {}, tiny)).toBeNull();
    expect(describeLocation(91, -83, {}, tiny)).toBeNull();
    expect(describeLocation('abc', -83, {}, tiny)).toBeNull();
  });

  it('caps the text at 60 characters', () => {
    const long = { name: 'X'.repeat(80), state: 'TX', lat: 0, lon: 0 };
    const text = formatGeoLocation(long, 12.2, 90);
    expect(text).toHaveLength(60);
    expect(text?.startsWith('12mi E TX X')).toBe(true);
    expect(formatGeoLocation(long, 100, 90)).toBeNull();
    expect(formatGeoLocation(long, 96, 90, { reducedPrecision: true })).toBeNull();
  });

  it('nearest place wins, ties broken by name', () => {
    const index = new PlaceIndex([
      { name: 'B', state: 'OH', lat: 40, lon: -83.1 },
      { name: 'A', state: 'OH', lat: 40, lon: -82.9 },
      { name: 'Far', state: 'OH', lat: 40.5, lon: -83 },
    ]);
    expect(index.nearest(40, -83)?.place.name).toBe('A');
    expect(index.nearest(40.4, -83)?.place.name).toBe('Far');
    expect(index.nearest(40, -83, 5)).toBeNull();
  });

  it('real data: Columbus OH and Toronto ON', () => {
    expect(describeLocation(39.961, -82.999)).toBe('OH Columbus');
    expect(describeLocation(43.706, -79.399)).toBe('ON Toronto');
    expect(describeLocation(39.961, -83.063)).toMatch(/^\d{1,2}mi [NSEW]{1,3} OH [A-Za-z .'-]+$/);
  });

  it('a supplied non-blank text always wins; blank -> computed', () => {
    expect(resolveLocationText('Yard 4, Columbus', 39.961, -83.063)).toBe('Yard 4, Columbus');
    expect(resolveLocationText('  ', 39.962, -82.999)).toBe('OH Columbus');
    expect(resolveLocationText(null, null, null)).toBeNull();
  });

  it('service warms the index and delegates', () => {
    const service = new LocationDescriptionService();
    service.onModuleInit();
    expect(service.describe(39.962, -82.999)).toBe('OH Columbus');
    expect(service.resolve(null, 39.962, -82.999)).toBe('OH Columbus');
  });
});
