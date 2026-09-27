/**
 * §22 DoS control — a report window is attacker-chosen. `from=1900-01-01&to=2999-12-31` used
 * to be accepted on both the synchronous preview routes and, worse, on `POST /reports/generate`
 * where `params` was `z.record(z.unknown())` and reached the worker unvalidated.
 */
import {
  ActivityReportParamsDto,
  ActivityReportQueryDto,
  ActivitySummaryQueryDto,
  DvirReportParamsDto,
  DvirReportQueryDto,
  FmcsaPackParamsDto,
  IftaReportQueryDto,
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

describe('ActivitySummaryQueryDto (gap B-46 — GET /reports/activity/summary)', () => {
  it('defaults page/limit/sort and shares the 366-day range cap', () => {
    const parsed = ActivitySummaryQueryDto.safeParse({ from: '2026-09-01', to: '2026-09-08' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.page).toBe(1);
      expect(parsed.data.limit).toBe(25);
      expect(parsed.data.sort).toBe('name:asc');
    }
    expect(ActivitySummaryQueryDto.safeParse({ from: '2026-01-01', to: '2027-12-31' }).success).toBe(false);
  });

  it('accepts driverId/terminal/status filters and rejects a bad status', () => {
    expect(
      ActivitySummaryQueryDto.safeParse({
        from: '2026-09-01',
        to: '2026-09-08',
        driverId: '11111111-1111-1111-1111-111111111111',
        terminal: 'Columbus, OH',
        status: 'ACTIVE',
      }).success,
    ).toBe(true);
    expect(ActivitySummaryQueryDto.safeParse({ from: '2026-09-01', to: '2026-09-08', status: 'RETIRED' }).success).toBe(false);
  });

  it('only accepts a whitelisted sort field:direction pair', () => {
    expect(ActivitySummaryQueryDto.safeParse({ from: '2026-09-01', to: '2026-09-08', sort: 'drivingSec:desc' }).success).toBe(
      true,
    );
    expect(ActivitySummaryQueryDto.safeParse({ from: '2026-09-01', to: '2026-09-08', sort: 'drivingSec' }).success).toBe(false);
    expect(
      ActivitySummaryQueryDto.safeParse({ from: '2026-09-01', to: '2026-09-08', sort: '"; DROP TABLE "DailyLog";--:asc' })
        .success,
    ).toBe(false);
  });

  it('coerces page/limit from query-string values and caps limit at 200', () => {
    const parsed = ActivitySummaryQueryDto.safeParse({ from: '2026-09-01', to: '2026-09-08', page: '2', limit: '50' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.page).toBe(2);
      expect(parsed.data.limit).toBe(50);
    }
    expect(ActivitySummaryQueryDto.safeParse({ from: '2026-09-01', to: '2026-09-08', limit: '500' }).success).toBe(false);
  });
});

// B-96 (web/backend-gaps.md) — GET /reports/{ifta,activity,dvir} accept `?format=PDF` so a
// READ-only caller (VIEWER) can get a PDF without needing `reports:FULL` (POST /reports/generate).
describe('B-96 — report shortcut ?format=CSV|PDF query DTOs', () => {
  it('IftaReportQueryDto defaults format to CSV when omitted and accepts PDF explicitly', () => {
    const defaulted = IftaReportQueryDto.safeParse({ quarter: '2026-Q3' });
    expect(defaulted.success).toBe(true);
    if (defaulted.success) expect(defaulted.data.format).toBe('CSV');

    const pdf = IftaReportQueryDto.safeParse({ quarter: '2026-Q3', format: 'PDF' });
    expect(pdf.success).toBe(true);
    if (pdf.success) expect(pdf.data.format).toBe('PDF');

    expect(IftaReportQueryDto.safeParse({ quarter: '2026-Q3', format: 'XLSX' }).success).toBe(false);
  });

  it('ActivityReportQueryDto accepts format alongside the existing range cap', () => {
    expect(
      ActivityReportQueryDto.safeParse({ from: '2026-09-01', to: '2026-09-08', format: 'PDF' }).success,
    ).toBe(true);
    expect(ActivityReportQueryDto.safeParse({ from: '1900-01-01', to: '2999-12-31', format: 'PDF' }).success).toBe(false);
  });

  it('DvirReportQueryDto accepts format alongside the existing range cap', () => {
    expect(DvirReportQueryDto.safeParse({ from: '2026-09-01', to: '2026-09-08', format: 'PDF' }).success).toBe(true);
    expect(DvirReportQueryDto.safeParse({ from: '1900-01-01', to: '2999-12-31', format: 'PDF' }).success).toBe(false);
  });
});
