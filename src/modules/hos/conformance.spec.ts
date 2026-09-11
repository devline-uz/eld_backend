/**
 * TZ §8.6 — the shared conformance suite. These JSON files in `eld.docs/hos-conformance/` are
 * language-neutral: the Dart engine (`lib/hos/engine/`, Phase 4b) reads the EXACT same files
 * and must produce the same answers. A single failure here blocks the build in both repos.
 *
 * Matching is partial: a fixture asserts only the fields it names, except `violations`, which
 * is always asserted in full (order, type, logDate and exceededBySec).
 */
import { computeHos } from './engine/compute-hos';
import type { HosState } from './hos.types';
import { fixtureToInput, loadFixtures, type ConformanceFixture } from '../../../test/helpers/hos';

const fixtures = loadFixtures();

function actualFor(state: HosState, key: string): unknown {
  const value = (state as unknown as Record<string, unknown>)[key];
  if (value instanceof Date) return value.toISOString().replace('.000Z', 'Z');
  return value;
}

function normalizeExpectedDate(value: unknown): unknown {
  return typeof value === 'string' && /\d{4}-\d{2}-\d{2}T/.test(value)
    ? new Date(value).toISOString().replace('.000Z', 'Z')
    : value;
}

describe('HOS conformance fixtures (eld.docs/hos-conformance)', () => {
  it('ships at least 40 shared fixtures for the Dart port', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(40);
  });

  it.each(fixtures.map((f): [string, ConformanceFixture] => [f.name, f]))('%s', (_name, fixture) => {
    const state = computeHos(fixtureToInput(fixture));

    for (const [key, expected] of Object.entries(fixture.expected)) {
      if (key === 'violations') {
        const expectedViolations = expected as Array<Record<string, unknown>>;
        expect(state.violations).toHaveLength(expectedViolations.length);
        expectedViolations.forEach((want, index) => {
          const got = state.violations[index];
          for (const [field, value] of Object.entries(want)) {
            expect({ field, value: field === 'occurredAt' ? got.occurredAt.toISOString().replace('.000Z', 'Z') : (got as unknown as Record<string, unknown>)[field] }).toEqual({
              field,
              value: normalizeExpectedDate(value),
            });
          }
        });
        continue;
      }
      expect({ key, value: actualFor(state, key) }).toEqual({ key, value: normalizeExpectedDate(expected) });
    }
  });
});
