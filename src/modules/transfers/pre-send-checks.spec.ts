import { MAX_TRANSFER_RANGE_DAYS, PreSendContext, runPreSendChecks } from './pre-send-checks';

function ctx(overrides: Partial<PreSendContext> = {}): PreSendContext {
  return {
    driverExists: true,
    rangeStart: new Date('2026-09-04T00:00:00Z'),
    rangeEnd: new Date('2026-09-11T00:00:00Z'),
    unresolvedUnidentifiedCount: 0,
    uncertifiedDayCount: 0,
    activeMalfunctionCodes: [],
    erodsMode: 'PRODUCTION',
    ...overrides,
  };
}

describe('tz.md §10.3 — pre-send validation', () => {
  it('passes a clean 8-day PRODUCTION request with no findings', () => {
    const result = runPreSendChecks(ctx());
    expect(result.findings).toEqual([]);
    expect(result.canGenerate).toBe(true);
  });

  it('accepts exactly 8 days and rejects 9 with RANGE_TOO_LARGE', () => {
    expect(runPreSendChecks(ctx()).errors).toEqual([]);
    const nine = runPreSendChecks(ctx({ rangeStart: new Date('2026-09-03T00:00:00Z') }));
    expect(nine.errors.map((e) => e.code)).toEqual(['RANGE_TOO_LARGE']);
    expect(nine.errors[0].details).toMatchObject({ days: 9, max: MAX_TRANSFER_RANGE_DAYS });
    expect(nine.canGenerate).toBe(false);
  });

  it('rejects an inverted range', () => {
    const result = runPreSendChecks(
      ctx({ rangeStart: new Date('2026-09-11T00:00:00Z'), rangeEnd: new Date('2026-09-04T00:00:00Z') }),
    );
    expect(result.errors.map((e) => e.code)).toEqual(['RANGE_TOO_LARGE']);
  });

  it('raises DRIVER_NOT_FOUND as a blocking error', () => {
    const result = runPreSendChecks(ctx({ driverExists: false }));
    expect(result.errors.map((e) => e.code)).toEqual(['DRIVER_NOT_FOUND']);
    expect(result.canGenerate).toBe(false);
  });

  it('raises TEST mode, uncertified logs, unidentified and malfunctions as NON-blocking warnings', () => {
    const result = runPreSendChecks(
      ctx({
        erodsMode: 'TEST',
        uncertifiedDayCount: 3,
        unresolvedUnidentifiedCount: 2,
        activeMalfunctionCodes: ['P', 'E'],
      }),
    );
    expect(result.warnings.map((w) => w.code).sort()).toEqual([
      'ACTIVE_MALFUNCTION',
      'ERODS_TEST_MODE',
      'UNCERTIFIED_LOGS',
      'UNRESOLVED_UNIDENTIFIED',
    ]);
    expect(result.errors).toEqual([]);
    // §395.24 — an imperfect log set must still be producible at roadside.
    expect(result.canGenerate).toBe(true);
  });

  it('does not warn about TEST mode when eRODS is in PRODUCTION', () => {
    expect(runPreSendChecks(ctx({ erodsMode: 'PRODUCTION' })).warnings).toEqual([]);
  });
});
