/**
 * §22 DoS control — a report window is attacker-chosen. `from=1900-01-01&to=2999-12-31` used
 * to be accepted on both the synchronous preview routes and, worse, on `POST /reports/generate`
 * where `params` was `z.record(z.unknown())` and reached the worker unvalidated.
 */
import {
  ActivityReportParamsDto,
  DvirReportParamsDto,
  FmcsaPackParamsDto,
  MAX_FMCSA_PACK_RANGE_DAYS,
  MAX_REPORT_RANGE_DAYS,
} from './reports.dto';

const day = (iso: string): string => iso;

describe('report range caps', () => {
  it('accepts a window at exactly the limit and rejects one day more', () => {
    // 2026-01-01 + 365 days = 2026-12-31 -> 365 days inclusive, well inside 366.
    expect(ActivityReportParamsDto.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success).toBe(true);
    expect(ActivityReportParamsDto.safeParse({ from: '2026-01-01', to: '2027-12-31' }).success).toBe(false);
    expect(MAX_REPORT_RANGE_DAYS).toBe(366);
  });

  it('rejects the unbounded-window DoS shape on every ranged report type', () => {
    const huge = { from: day('1900-01-01'), to: day('2999-12-31') };
    expect(ActivityReportParamsDto.safeParse(huge).success).toBe(false);
    expect(DvirReportParamsDto.safeParse(huge).success).toBe(false);
    expect(FmcsaPackParamsDto.safeParse(huge).success).toBe(false);
  });

  it('caps the FMCSA pack at the same 62 RODS days as GET /logs/:driverId/range', () => {
    expect(MAX_FMCSA_PACK_RANGE_DAYS).toBe(62);
    expect(FmcsaPackParamsDto.safeParse({ from: '2026-01-01', to: '2026-03-03' }).success).toBe(true);
    expect(FmcsaPackParamsDto.safeParse({ from: '2026-01-01', to: '2026-06-01' }).success).toBe(false);
  });

  it('rejects an inverted range instead of quietly generating nothing', () => {
    expect(ActivityReportParamsDto.safeParse({ from: '2026-05-02', to: '2026-05-01' }).success).toBe(false);
    expect(ActivityReportParamsDto.safeParse({ from: '2026-05-01', to: '2026-05-01' }).success).toBe(true);
  });

  it('still enforces the date shape and the optional uuid filters', () => {
    expect(ActivityReportParamsDto.safeParse({ from: '05/01/2026', to: '2026-05-02' }).success).toBe(false);
    expect(
      ActivityReportParamsDto.safeParse({ from: '2026-05-01', to: '2026-05-02', driverId: 'not-a-uuid' }).success,
    ).toBe(false);
  });
});
