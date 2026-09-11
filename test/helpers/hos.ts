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

export function loadFixtures(): ConformanceFixture[] {
  return readdirSync(CONFORMANCE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CONFORMANCE_DIR, f), 'utf8')) as ConformanceFixture);
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
