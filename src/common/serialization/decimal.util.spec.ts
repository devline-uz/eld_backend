import { Prisma } from '@prisma/client';
import { serializeDecimals } from './decimal.util';

describe('serializeDecimals (B-111 — Prisma Decimal -> number)', () => {
  it('converts a top-level Decimal to a number', () => {
    expect(serializeDecimals(new Prisma.Decimal('38.897639'))).toBe(38.897639);
  });

  it('converts Decimal fields nested inside a plain object', () => {
    const out = serializeDecimals({ centerLat: new Prisma.Decimal('38.9'), name: 'x' });
    expect(out).toEqual({ centerLat: 38.9, name: 'x' });
    expect(typeof out.centerLat).toBe('number');
  });

  it('converts Decimal fields nested inside arrays / items lists', () => {
    const out = serializeDecimals({
      items: [{ latitude: new Prisma.Decimal('40.71'), longitude: new Prisma.Decimal('-74.0') }],
    });
    expect(out.items[0]).toEqual({ latitude: 40.71, longitude: -74 });
  });

  it('leaves null/undefined Decimal-shaped fields alone', () => {
    expect(serializeDecimals({ costUsd: null })).toEqual({ costUsd: null });
    expect(serializeDecimals(undefined)).toBeUndefined();
  });

  it('leaves Date instances untouched (not walked as a plain object)', () => {
    const date = new Date('2026-09-24T00:00:00.000Z');
    const out = serializeDecimals({ createdAt: date });
    expect(out.createdAt).toBe(date);
  });

  it('leaves Buffer instances untouched', () => {
    const buf = Buffer.from('abc');
    expect(serializeDecimals({ blob: buf }).blob).toBe(buf);
  });

  it('leaves primitives (string/number/boolean) untouched', () => {
    expect(serializeDecimals('x')).toBe('x');
    expect(serializeDecimals(5)).toBe(5);
    expect(serializeDecimals(true)).toBe(true);
  });

  it('does not mutate the original object', () => {
    const original = { radiusMi: new Prisma.Decimal('0.5') };
    const out = serializeDecimals(original);
    expect(original.radiusMi).toBeInstanceOf(Prisma.Decimal);
    expect(out.radiusMi).toBe(0.5);
  });

  it('tolerates a self-referential object without infinite recursion', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => serializeDecimals(cyclic)).not.toThrow();
  });
});
