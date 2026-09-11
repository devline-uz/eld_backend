import {
  KM_TO_MI,
  KPA_TO_PSI,
  L_TO_GAL,
  celsiusToCelsius,
  galToL,
  kmToMi,
  kmhToMph,
  kmplToMpg,
  kpaToPsi,
  lToGal,
  lphToGph,
  miToKm,
  mphToKmh,
  psiToKpa,
} from './convert';

describe('units/convert (TZ §4.2)', () => {
  it('exposes the normative ratios', () => {
    expect(KM_TO_MI).toBe(0.621371);
    expect(L_TO_GAL).toBe(0.264172);
    expect(KPA_TO_PSI).toBe(0.145038);
  });

  describe('kmToMi', () => {
    it.each([
      [0, 0],
      [1, 1],
      [100, 62],
      [1609.344, 1000],
      [-100, -62],
    ])('kmToMi(%p) === %p', (km, mi) => {
      expect(kmToMi(km)).toBe(mi);
    });
    it('returns whole miles', () => {
      expect(Number.isInteger(kmToMi(123.456))).toBe(true);
    });
  });

  describe('kmhToMph', () => {
    it.each([
      [0, 0],
      [100, 62],
      [105, 65],
      [1, 1],
    ])('kmhToMph(%p) === %p', (kmh, mph) => {
      expect(kmhToMph(kmh)).toBe(mph);
    });
  });

  describe('lToGal', () => {
    it.each([
      [0, 0],
      [1, 0.26],
      [100, 26.42],
      [378.541, 100],
    ])('lToGal(%p) === %p', (l, gal) => {
      expect(lToGal(l)).toBe(gal);
    });
    it('keeps at most 2 decimals', () => {
      expect(lToGal(37.854)).toBe(10);
    });
  });

  describe('kpaToPsi', () => {
    it.each([
      [0, 0],
      [100, 14.5],
      [689.476, 100],
    ])('kpaToPsi(%p) === %p', (kpa, psi) => {
      expect(kpaToPsi(kpa)).toBe(psi);
    });
  });

  it('converts fuel rate L/h → gal/h', () => {
    expect(lphToGph(0)).toBe(0);
    expect(lphToGph(10)).toBe(2.64);
  });

  it('converts economy km/L → mpg', () => {
    expect(kmplToMpg(0)).toBe(0);
    expect(kmplToMpg(3)).toBe(7.1);
  });

  describe('inverse companions', () => {
    it('miToKm', () => {
      expect(miToKm(0)).toBe(0);
      expect(miToKm(62)).toBe(99.779);
    });
    it('mphToKmh', () => {
      expect(mphToKmh(65)).toBe(104.607);
    });
    it('galToL', () => {
      expect(galToL(1)).toBe(3.785);
    });
    it('psiToKpa', () => {
      expect(psiToKpa(100)).toBe(689.5);
    });
  });

  it('leaves Celsius untouched', () => {
    expect(celsiusToCelsius(-40)).toBe(-40);
    expect(celsiusToCelsius(21.5)).toBe(21.5);
  });
});
