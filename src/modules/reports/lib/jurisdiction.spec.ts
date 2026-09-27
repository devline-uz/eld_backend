import { haversineMiles, isKnownJurisdiction, jurisdictionFor, JURISDICTION_BOXES, listJurisdictions } from './jurisdiction';

describe('jurisdictionFor (TZ §15 IFTA jurisdiction lookup)', () => {
  it('resolves a well-known point inside Ohio', () => {
    expect(jurisdictionFor(39.9612, -82.9988)).toBe('OH'); // Columbus, OH
  });

  it('resolves a well-known point inside Kentucky', () => {
    expect(jurisdictionFor(38.0406, -84.5037)).toBe('KY'); // Lexington, KY
  });

  it('resolves a point inside Ontario, Canada', () => {
    expect(jurisdictionFor(45.4215, -75.6972)).toBe('ON'); // Ottawa — clear of the Great Lakes NY/ON overlap
  });

  it('returns null for a point far outside every box (open ocean)', () => {
    expect(jurisdictionFor(0, 0)).toBeNull();
  });

  it('every box has a well-formed, non-crossing lat/lon range', () => {
    for (const box of JURISDICTION_BOXES) {
      expect(box.minLat).toBeLessThan(box.maxLat);
      expect(box.minLon).toBeLessThan(box.maxLon);
    }
  });
});

describe('haversineMiles', () => {
  it('is ~0 for the same point', () => {
    expect(haversineMiles(39.96, -82.99, 39.96, -82.99)).toBeCloseTo(0, 3);
  });

  it('matches the known ~155mi Columbus,OH -> Lexington,KY great-circle (straight-line) distance', () => {
    const miles = haversineMiles(39.9612, -82.9988, 38.0406, -84.5037);
    expect(miles).toBeGreaterThan(145);
    expect(miles).toBeLessThan(165);
  });
});

describe('listJurisdictions (W-12 `Jurisdiction` menu)', () => {
  it('lists every resolvable code exactly once, each with a real name', () => {
    const items = listJurisdictions();
    expect(items.map((i) => i.code).sort()).toEqual(JURISDICTION_BOXES.map((b) => b.code).sort());
    for (const item of items) expect(item.name).not.toBe(item.code);
  });

  it('puts US states first, then Canadian provinces, each sorted by name', () => {
    const items = listJurisdictions();
    const firstCa = items.findIndex((i) => i.country === 'CA');
    expect(items.slice(firstCa).every((i) => i.country === 'CA')).toBe(true);
    expect(items[0]).toEqual({ code: 'AL', name: 'Alabama', country: 'US' });
    expect(items.find((i) => i.code === 'ON')).toEqual({ code: 'ON', name: 'Ontario', country: 'CA' });
  });

  it('isKnownJurisdiction accepts listed codes only', () => {
    expect(isKnownJurisdiction('OH')).toBe(true);
    expect(isKnownJurisdiction('ZZ')).toBe(false);
  });
});
