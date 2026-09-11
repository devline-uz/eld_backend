import { z } from 'zod';

/** TZ §11.6 / §15 — the four report kinds v1 ships. `SAFETY`/`UNIDENTIFIED` exist on the
 * `ReportType` enum for Phase 10/other consumers but are not generated through this endpoint
 * yet — kept out of the zod enum so a bad request fails fast instead of queuing a job nothing
 * can service. */
export const GENERATABLE_REPORT_TYPES = ['IFTA', 'ACTIVITY', 'DVIR', 'FMCSA_PACK'] as const;

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

/** IFTA params: `quarter` as `YYYY-Q#` (e.g. `2026-Q3`) per tz.md §15/§11.6 `?quarter=`. */
export const IftaReportParamsDto = z.object({
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/),
  vehicleId: z.string().uuid().optional(),
});
export type IftaReportParamsDto = z.infer<typeof IftaReportParamsDto>;

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

export const ActivityReportParamsDto = boundedRange(
  z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    driverId: z.string().uuid().optional(),
  }),
  MAX_REPORT_RANGE_DAYS,
);
export type ActivityReportParamsDto = z.infer<typeof ActivityReportParamsDto>;

export const DvirReportParamsDto = boundedRange(
  z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    vehicleId: z.string().uuid().optional(),
  }),
  MAX_REPORT_RANGE_DAYS,
);
export type DvirReportParamsDto = z.infer<typeof DvirReportParamsDto>;

export const FmcsaPackParamsDto = boundedRange(
  z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    driverId: z.string().uuid().optional(),
  }),
  MAX_FMCSA_PACK_RANGE_DAYS,
);
export type FmcsaPackParamsDto = z.infer<typeof FmcsaPackParamsDto>;

const cronField = z.string().min(1);
export const CreateReportScheduleDto = z.object({
  reportType: z.enum(GENERATABLE_REPORT_TYPES),
  format: z.enum(['CSV', 'PDF', 'XLSX']).default('CSV'),
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
