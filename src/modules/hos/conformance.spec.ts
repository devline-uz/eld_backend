/**
 * TZ §8.6 — the shared conformance suite. These JSON files in `test/conformance/golden/` are
 * language-neutral: the Dart engine (`lib/hos/engine/`, Phase 4b) reads the EXACT same files
 * and must produce the same answers. A single failure here blocks the build in both repos.
 *
 * Matching is partial: a fixture asserts only the fields it names, except `violations`, which
 * is always asserted in full (order, type, logDate and exceededBySec).
 */
import { computeHos } from './engine/compute-hos';
import { expectFixture, fixtureToInput, loadFixtures, type ConformanceFixture } from '../../../test/helpers/hos';

const fixtures = loadFixtures();

describe('HOS conformance fixtures (test/conformance/golden)', () => {
  it('ships at least 40 shared fixtures for the Dart port', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(40);
  });

  it.each(fixtures.map((f): [string, ConformanceFixture] => [f.name, f]))('%s', (_name, fixture) => {
    expectFixture(computeHos(fixtureToInput(fixture)), fixture);
  });
});
