/**
 * MR-33 — the mobile team's HOS conformance scenarios (`eld_mobile/test/conformance/scenarios/*.json`,
 * 74 files) run through the TS engine too, so both engines must agree. The files are copied
 * unchanged into `backend/test/conformance/scenarios/` (format: README.md there). The mobile format
 * is `{ id, rule, title, input, expect }`; `input` is already a TS `HosInput` (ISO-8601 instants),
 * so this runner only renames `id`→`name` / `expect`→`expected` and reuses the SAME converter and
 * matcher as the `test/conformance/golden` suite. Reference: the mobile `conformance_test.dart`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeHos } from './engine/compute-hos';
import { expectFixture, fixtureToInput, type ConformanceFixture } from '../../../test/helpers/hos';

const MOBILE_SCENARIO_DIR = join(__dirname, '..', '..', '..', 'test', 'conformance', 'scenarios');
/** The count the mobile team ships (request 2026-10-08, #33). A partial copy fails loudly. */
const EXPECTED_MOBILE_SCENARIOS = 74;

/** One mobile scenario file, as written by the Dart side. */
interface MobileScenario {
  /** Equals the file name without `.json`. */
  id: string;
  /** Grouping tag (`DRIVING_11`, `SPLIT_SLEEPER`, ...). */
  rule: string;
  title: string;
  input: ConformanceFixture['input'];
  /** Partial `HosState`; `violations`, when present, is a full ordered `{type, logDate, exceededBySec}` list. */
  expect: Record<string, unknown>;
}

interface LoadedScenario {
  file: string;
  scenario: MobileScenario;
  fixture: ConformanceFixture;
}

function loadMobileScenarios(dir: string): LoadedScenario[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const scenario = JSON.parse(readFileSync(join(dir, file), 'utf8')) as MobileScenario;
      const fixture: ConformanceFixture = {
        name: scenario.id ?? file,
        spec: scenario.title,
        input: scenario.input,
        expected: scenario.expect ?? {},
      };
      return { file, scenario, fixture };
    });
}

const present = existsSync(MOBILE_SCENARIO_DIR) && readdirSync(MOBILE_SCENARIO_DIR).some((f) => f.endsWith('.json'));
const scenarios: LoadedScenario[] = present ? loadMobileScenarios(MOBILE_SCENARIO_DIR) : [];

describe('HOS conformance — mobile scenarios (MR-33)', () => {
  if (!present) {
    it.todo(`copy the ${EXPECTED_MOBILE_SCENARIOS} mobile scenario files into test/conformance/scenarios/`);
    return;
  }

  it(`ships all ${EXPECTED_MOBILE_SCENARIOS} mobile scenarios`, () => {
    expect(scenarios.length).toBe(EXPECTED_MOBILE_SCENARIOS);
  });

  it('ids are unique and match the file name', () => {
    const ids = scenarios.map((s) => s.scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { file, scenario } of scenarios) expect(`${scenario.id}.json`).toBe(file);
  });

  it.each(scenarios.map((s): [string, string, LoadedScenario] => [s.scenario.rule, s.scenario.id, s]))(
    '[%s] %s',
    (_rule, _id, { scenario, fixture }) => {
      expect(scenario.input?.events).toBeInstanceOf(Array);
      expect(typeof scenario.expect).toBe('object');
      expectFixture(computeHos(fixtureToInput(fixture)), fixture);
    },
  );
});
