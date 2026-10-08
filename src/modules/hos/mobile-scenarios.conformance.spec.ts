/**
 * MR-33 — the mobile team's HOS conformance scenarios (`mobile/test/conformance/scenarios/*.json`,
 * 74 files) run through the TS engine too, so both engines must agree. The files are copied into
 * `backend/test/conformance/scenarios/` (format: README.md there); this runner reads every
 * `*.json` in that directory with the SAME loader and matcher as the `eld.docs/hos-conformance`
 * suite. Until the files are copied in, the suite reports a single `todo` instead of failing.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { computeHos } from './engine/compute-hos';
import { expectFixture, fixtureToInput, loadFixtures, type ConformanceFixture } from '../../../test/helpers/hos';

const MOBILE_SCENARIO_DIR = join(__dirname, '..', '..', '..', 'test', 'conformance', 'scenarios');
/** The count the mobile team ships (request 2026-10-08, #33). A partial copy fails loudly. */
const EXPECTED_MOBILE_SCENARIOS = 74;

const present = existsSync(MOBILE_SCENARIO_DIR) && readdirSync(MOBILE_SCENARIO_DIR).some((f) => f.endsWith('.json'));
const scenarios: ConformanceFixture[] = present ? loadFixtures(MOBILE_SCENARIO_DIR) : [];

describe('HOS conformance — mobile scenarios (MR-33)', () => {
  if (!present) {
    it.todo(`copy the ${EXPECTED_MOBILE_SCENARIOS} mobile scenario files into test/conformance/scenarios/`);
    return;
  }

  it(`ships all ${EXPECTED_MOBILE_SCENARIOS} mobile scenarios`, () => {
    expect(scenarios.length).toBe(EXPECTED_MOBILE_SCENARIOS);
  });

  it.each(scenarios.map((s): [string, ConformanceFixture] => [s.name, s]))('%s', (_name, scenario) => {
    expect(scenario.input?.events).toBeInstanceOf(Array);
    expect(typeof scenario.expected).toBe('object');
    expectFixture(computeHos(fixtureToInput(scenario)), scenario);
  });
});
