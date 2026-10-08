/**
 * Shared builders for the HOS unit tests and the language-neutral conformance runner
 * (TZ §8.6). Lives under `test/` on purpose: nothing here is production code, and `hos/`
 * coverage must measure the engine, not its scaffolding.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DriverHosConfig,
  DutyStatus,
  HosInput,
  HosRuleset,
  HosState,
  NormalizedEvent,
  SpecialDrivingCategory,
} from '../../src/modules/hos/hos.types';


export const H = 3600;
export const M = 60;

/** Default test zone: America/New_York, so DST and "home terminal ≠ carrier" are testable. */
export const TZ = 'America/New_York';

export function at(iso: string): Date {
  return new Date(iso);
}

export function ev(
  iso: string,
  status: DutyStatus,
  special: SpecialDrivingCategory = 'NONE',
  extra: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return { at: at(iso), status, special, ...extra };
}

export function driver(overrides: Partial<DriverHosConfig> = {}): DriverHosConfig {
  return { driverId: 'driver-1', splitSleeperEnabled: true, ...overrides };
}

export function input(overrides: Partial<HosInput> = {}): HosInput {
  return {
    events: [],
    driver: driver(),
    ruleset: 'US_70_8_PROPERTY',
    now: at('2025-01-15T12:00:00Z'),
    timezone: TZ,
    previousDays: [],
    lastRestartEndedAt: null,
    ...overrides,
  };
}

/** Builds a timeline from `[durationSeconds, status]` pairs starting at `startIso`. */
export function timeline(startIso: string, steps: Array<[number, DutyStatus, SpecialDrivingCategory?]>): {
  events: NormalizedEvent[];
  end: Date;
} {
  let cursor = at(startIso).getTime();
  const events: NormalizedEvent[] = [];
  for (const [seconds, status, special] of steps) {
    events.push({ at: new Date(cursor), status, special: special ?? 'NONE' });
    cursor += seconds * 1000;
  }
  return { events, end: new Date(cursor) };
}

// ---------------------------------------------------------------------------
// Conformance fixtures (TZ §8.6) — the SAME files are read by the Dart engine.
// ---------------------------------------------------------------------------

export const CONFORMANCE_DIR = join(__dirname, '..', '..', '..', 'eld.docs', 'hos-conformance');

export interface ConformanceFixture {
  name: string;
  spec?: string;
  input: {
    events: Array<{ at: string; status: DutyStatus; special?: SpecialDrivingCategory; recordStatus?: number; eventSequenceId?: number }>;
    driver: DriverHosConfig;
    ruleset: HosRuleset;
    now: string;
    timezone: string;
    previousDays: Array<{ date: string; onDutySec: number }>;
    lastRestartEndedAt: string | null;
  };
  expected: Record<string, unknown>;
}

export function loadFixtures(dir: string = CONFORMANCE_DIR): ConformanceFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const fixture = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ConformanceFixture;
      // A fixture without `name` is reported by its file name (MR-33: the mobile scenario files).
      return { ...fixture, name: fixture.name ?? f };
    });
}

/**
 * Asserts a fixture's `expected` block against the engine output. Matching is partial: only the
 * named fields are checked, except `violations`, which is always asserted in full (count, order,
 * and every named field). Instants compare by value (`...00.000Z` equals `...00Z`).
 */
export function expectFixture(state: HosState, fixture: ConformanceFixture): void {
  const iso = (value: Date): string => value.toISOString().replace('.000Z', 'Z');
  const normalize = (value: unknown): unknown =>
    typeof value === 'string' && /\d{4}-\d{2}-\d{2}T/.test(value) ? iso(new Date(value)) : value;
  const actual = (key: string): unknown => {
    const value = (state as unknown as Record<string, unknown>)[key];
    return value instanceof Date ? iso(value) : value;
  };

  for (const [key, expected] of Object.entries(fixture.expected)) {
    if (key === 'violations') {
      const want = expected as Array<Record<string, unknown>>;
      expect({ key, count: state.violations.length }).toEqual({ key, count: want.length });
      want.forEach((fields, index) => {
        const got = state.violations[index] as unknown as Record<string, unknown>;
        for (const [field, value] of Object.entries(fields)) {
          const gotValue = got[field] instanceof Date ? iso(got[field]) : got[field];
          expect({ field: `violations[${index}].${field}`, value: gotValue }).toEqual({
            field: `violations[${index}].${field}`,
            value: normalize(value),
          });
        }
      });
      continue;
    }
    expect({ key, value: actual(key) }).toEqual({ key, value: normalize(expected) });
  }
}

export function fixtureToInput(fixture: ConformanceFixture): HosInput {
  return {
    events: fixture.input.events.map((e) => ({
      at: new Date(e.at),
      status: e.status,
      special: e.special ?? 'NONE',
      recordStatus: e.recordStatus,
      eventSequenceId: e.eventSequenceId,
    })),
    driver: fixture.input.driver,
    ruleset: fixture.input.ruleset,
    now: new Date(fixture.input.now),
    timezone: fixture.input.timezone,
    previousDays: fixture.input.previousDays ?? [],
    lastRestartEndedAt: fixture.input.lastRestartEndedAt ? new Date(fixture.input.lastRestartEndedAt) : null,
  };
}
