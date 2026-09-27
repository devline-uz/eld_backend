import { z } from 'zod';
import { isKnownJurisdiction } from '../lib/jurisdiction';

/** TZ §11.6 / §15 — the report kinds v1 ships. `SAFETY`/`UNIDENTIFIED` exist on the
 * `ReportType` enum for Phase 10/other consumers but are not generated through this endpoint
 * yet — kept out of the zod enum so a bad request fails fast instead of queuing a job nothing
 * can service. B-14 adds `RODS` (printable 8-day log sheets) and `IDLE_FUEL` (idle time/fuel
 * waste from telemetry). */
export const GENERATABLE_REPORT_TYPES = ['IFTA', 'ACTIVITY', 'DVIR', 'FMCSA_PACK', 'RODS', 'IDLE_FUEL'] as const;

/** B-48 — `IFTA`/`ACTIVITY`/`DVIR` now generate as CSV or PDF; `FMCSA_PACK` stays PDF-only
 * (Appendix A CSVs are attached per driver alongside the cover PDF); `RODS`/`IDLE_FUEL` are
 * PDF-only (printable log sheets / a fuel-waste report, never a raw CSV export in v1). */
export const REPORT_TYPE_FORMATS: Record<(typeof GENERATABLE_REPORT_TYPES)[number], readonly ('CSV' | 'PDF')[]> = {
  IFTA: ['CSV', 'PDF'],
  ACTIVITY: ['CSV', 'PDF'],
  DVIR: ['CSV', 'PDF'],
  FMCSA_PACK: ['PDF'],
  RODS: ['PDF'],
  IDLE_FUEL: ['PDF'],
};

/** B-48 — scheduled reports may ask for a period relative to when the scheduler runs, instead
 * of a fixed `from`/`to` baked in at schedule-creation time. */
export const REPORT_WINDOWS = ['PREVIOUS_WEEK', 'PREVIOUS_MONTH', 'PREVIOUS_QUARTER'] as const;
export type ReportWindow = (typeof REPORT_WINDOWS)[number];

export const GenerateReportDto = z.object({
  type: z.enum(GENERATABLE_REPORT_TYPES),
  format: z.enum(['CSV', 'PDF', 'XLSX']).default('CSV'),
  params: z.record(z.unknown()).default({}),
});
export type GenerateReportDto = z.infer<typeof GenerateReportDto>;

export const ReportListQueryDto = z.object({
  type: z.enum(GENERATABLE_REPORT_TYPES).optional(),
  status: z.enum(['QUEUED', 'RUNNING', 'READY', 'FAILED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});
export type ReportListQueryDto = z.infer<typeof ReportListQueryDto>;

/** B-96 (web/backend-gaps.md) — the READ-level `GET /reports/{ifta,activity,dvir}` shortcuts
 * defaulted to CSV with no way to ask for PDF, so a VIEWER (`reports: READ`, never `FULL`)
 * could never get a PDF report — `POST /reports/generate` (the only PDF path) requires
 * `reports: FULL`. `?format=PDF` on the shortcuts closes that: generation permission is
 * unchanged (still gated by the route's own `@Perm`, `READ` here, same as before), only the
 * requested output format changes; `assertFormatAllowed()` still rejects a type/format pair
 * that isn't in `REPORT_TYPE_FORMATS` (nothing here bypasses that check). */

/** IFTA params: `quarter` as `YYYY-Q#` (e.g. `2026-Q3`) per tz.md §15/§11.6 `?quarter=`. */
export const IftaReportParamsDto = z.object({
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/),
  vehicleId: z.string().uuid().optional(),
  /** Only units in this vehicle group (`/vehicle-groups`). Combined with `vehicleId` = both must match. */
  vehicleGroupId: z.string().uuid().optional(),
  /** Two-letter IFTA code from `GET /reports/ifta/jurisdictions` — narrows rows to that one. */
  jurisdiction: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase())
    .refine(isKnownJurisdiction, 'Unknown IFTA jurisdiction — see GET /reports/ifta/jurisdictions.')
    .optional(),
});
export type IftaReportParamsDto = z.infer<typeof IftaReportParamsDto>;
/** B-96 — `GET /reports/ifta`'s own query shape: the generator params above PLUS the shortcut
 * `?format=` this route accepts. Kept separate from `IftaReportParamsDto` because that type is
 * reused as `IftaReportGenerator`'s own `params` argument (and as the persisted `Report.params`
 * shape) — it must never carry a `format` field of its own. */
export const IftaReportQueryDto = IftaReportParamsDto.extend({ format: z.enum(['CSV', 'PDF']).default('CSV') });
export type IftaReportQueryDto = z.infer<typeof IftaReportQueryDto>;

/** `GET /reports/ifta/summary` params (gap B-46, web/tz.md §20) — the same filters as the CSV/PDF
 * export, so the screen and the file it exports always describe the same slice. */
export const IftaSummaryParamsDto = IftaReportParamsDto;
export type IftaSummaryParamsDto = z.infer<typeof IftaSummaryParamsDto>;

/**
 * §22 DoS control — a report window is attacker-chosen and every day in it costs RODS queries
 * plus a rendered page. Without a ceiling, `from=1900-01-01&to=2999-12-31` is a single cheap
 * request that pins a worker for hours. 366 days covers the widest legitimate reporting
 * window (a full year); the FMCSA pack is capped tighter, at the same 62 RODS days
 * `GET /logs/:driverId/range` allows.
 */
export const MAX_REPORT_RANGE_DAYS = 366;
export const MAX_FMCSA_PACK_RANGE_DAYS = 62;

const DAY_MS = 86_400_000;

function boundedRange<T extends z.ZodType<{ from: string; to: string }>>(schema: T, maxDays: number): z.ZodEffects<T> {
  return schema.refine(
    ({ from, to }) => {
      const start = Date.parse(`${from}T00:00:00Z`);
      const end = Date.parse(`${to}T00:00:00Z`);
      if (Number.isNaN(start) || Number.isNaN(end)) return false;
      const days = (end - start) / DAY_MS + 1;
      return days >= 1 && days <= maxDays;
    },
    { message: `\`to\` must be on or after \`from\` and the range must not exceed ${maxDays} days.` },
  );
}

const ActivityReportParamsShape = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  driverId: z.string().uuid().optional(),
});
export const ActivityReportParamsDto = boundedRange(ActivityReportParamsShape, MAX_REPORT_RANGE_DAYS);
export type ActivityReportParamsDto = z.infer<typeof ActivityReportParamsDto>;
/** B-96 — see `IftaReportQueryDto`'s doc comment; same reasoning for `GET /reports/activity`. */
export const ActivityReportQueryDto = boundedRange(
  ActivityReportParamsShape.extend({ format: z.enum(['CSV', 'PDF']).default('CSV') }),
  MAX_REPORT_RANGE_DAYS,
);
export type ActivityReportQueryDto = z.infer<typeof ActivityReportQueryDto>;

/** `GET /reports/activity/summary` sort keys (gap B-46, web `web/backend-gaps.md`) — the raw
 * SQL repository maps each to a whitelisted column expression; never interpolate `sort` itself
 * into SQL. */
export const ACTIVITY_SUMMARY_SORT_FIELDS = [
  'name',
  'days',
  'offSec',
  'sbSec',
  'drivingSec',
  'onSec',
  'distanceMi',
  'violations',
  'certifiedDays',
] as const;
export type ActivitySummarySortField = (typeof ACTIVITY_SUMMARY_SORT_FIELDS)[number];

export const ACTIVITY_SUMMARY_GROUP_BY = ['driver', 'vehicleGroup'] as const;

/**
 * `GET /reports/activity/summary` params (gap B-46) — JSON per-driver aggregate over a date
 * range, so the web stops fanning out one `GET /logs/:driverId/range` call per driver (W-13,
 * W-15, dashboard — WD-039). Same `from`/`to`/range-cap shape as the CSV export params above
 * plus pagination/filter/sort, since this is a paged list endpoint, not a queued report.
 */
export const ActivitySummaryQueryDto = boundedRange(
  z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    driverId: z.string().uuid().optional(),
    terminal: z.string().min(1).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'TERMINATED']).optional(),
    /** Only drivers whose currently assigned unit is in this vehicle group. */
    vehicleGroupId: z.string().uuid().optional(),
    /** `driver` (default) = one row per driver; `vehicleGroup` = one row per vehicle group of
     * the driver's currently assigned unit (drivers with no unit / an ungrouped unit fall in
     * one `groupId: null` row). `name` sorts by group name in that mode. */
    groupBy: z.enum(ACTIVITY_SUMMARY_GROUP_BY).default('driver'),
    sort: z
      .string()
      .regex(/^(name|days|offSec|sbSec|drivingSec|onSec|distanceMi|violations|certifiedDays):(asc|desc)$/)
      .default('name:asc'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(25),
  }),
  MAX_REPORT_RANGE_DAYS,
);
export type ActivitySummaryQueryDto = z.infer<typeof ActivitySummaryQueryDto>;

const DvirReportParamsShape = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vehicleId: z.string().uuid().optional(),
});
export const DvirReportParamsDto = boundedRange(DvirReportParamsShape, MAX_REPORT_RANGE_DAYS);
export type DvirReportParamsDto = z.infer<typeof DvirReportParamsDto>;
/** B-96 — see `IftaReportQueryDto`'s doc comment; same reasoning for `GET /reports/dvir`. */
export const DvirReportQueryDto = boundedRange(
  DvirReportParamsShape.extend({ format: z.enum(['CSV', 'PDF']).default('CSV') }),
  MAX_REPORT_RANGE_DAYS,
);
export type DvirReportQueryDto = z.infer<typeof DvirReportQueryDto>;

/** B-48 — sections the cover PDF/appendix bundle may be limited to. No `include` (the
 * default) means the full pack, unchanged from before this gap was closed. */
export const FMCSA_PACK_SECTIONS = ['RODS', 'UNIDENTIFIED', 'EDITS', 'ELD_ID', 'DVIR', 'MALFUNCTIONS'] as const;
export type FmcsaPackSection = (typeof FMCSA_PACK_SECTIONS)[number];

export const FmcsaPackParamsDto = boundedRange(
  z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    driverId: z.string().uuid().optional(),
    vehicleId: z.string().uuid().optional(),
    include: z.array(z.enum(FMCSA_PACK_SECTIONS)).min(1).optional(),
  }),
  MAX_FMCSA_PACK_RANGE_DAYS,
);
export type FmcsaPackParamsDto = z.infer<typeof FmcsaPackParamsDto>;

/** B-14 — RODS: printable 8-day (or any bounded range) log sheets, one per driver per day. */
export const RodsReportParamsDto = boundedRange(
  z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    driverId: z.string().uuid().optional(),
  }),
  MAX_FMCSA_PACK_RANGE_DAYS,
);
export type RodsReportParamsDto = z.infer<typeof RodsReportParamsDto>;

/** B-14 — idle time / fuel-waste, from `TelemetryPoint` (§5.6). Bounded to the general report
 * range cap since it can span a whole fleet. */
export const IdleFuelReportParamsDto = boundedRange(
  z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    driverId: z.string().uuid().optional(),
    vehicleId: z.string().uuid().optional(),
  }),
  MAX_REPORT_RANGE_DAYS,
);
export type IdleFuelReportParamsDto = z.infer<typeof IdleFuelReportParamsDto>;

const cronField = z.string().min(1);
export const CreateReportScheduleDto = z.object({
  reportType: z.enum(GENERATABLE_REPORT_TYPES),
  format: z.enum(['CSV', 'PDF', 'XLSX']).default('CSV'),
  /** B-48 — `params.window` (`'PREVIOUS_WEEK' | 'PREVIOUS_MONTH' | 'PREVIOUS_QUARTER'`, see
   * `REPORT_WINDOWS`) lets a schedule ask for a period relative to each run instead of a fixed
   * `from`/`to` baked in once at creation time — already representable in this `z.record`, the
   * scheduler resolves it into a concrete `from`/`to` on each `nextRunAt`
   * (`report-scheduler.processor.ts`). */
  params: z.record(z.unknown()).default({}),
  /** Standard 5-field cron, e.g. `0 6 * * 1` = every Monday 06:00 (§15 report scheduler). */
  cron: cronField,
  timezone: z.string().default('UTC'),
  recipients: z.array(z.string().email()).default([]),
  enabled: z.boolean().default(true),
});
export type CreateReportScheduleDto = z.infer<typeof CreateReportScheduleDto>;

export const UpdateReportScheduleDto = CreateReportScheduleDto.partial();
export type UpdateReportScheduleDto = z.infer<typeof UpdateReportScheduleDto>;
